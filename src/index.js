const childProcessDebug = require('child-process-debug');
const bunyan = require('bunyan');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const _ = require('lodash');
const deferred = require('deferred');
const localConfigReader = require('./local-config-reader');

(function() {
  let childProcesses = [];
  let localConfig;
  let logger;

  function FindChildProcess(processes, toFindString) { 
      return _.find(processes, function(p) {
        return _.some(p.spawnargs, function(sa) {
          return sa.indexOf(toFindString) > -1;
        });
      });
  }
  function ProcessStatusUpdate(msg) {
    if(msg.type !== 'StatusUpdate') return;
      const statusProcess = FindChildProcess(childProcesses, 'status');
      if(!statusProcess.connected) return;

      statusProcess.send({
        type:'StatusUpdate',
        payload: msg.payload,
      });
  }
  function onEncoderMessage(msg) {
    if(msg.type === 'StatusUpdate') {
      ProcessStatusUpdate(msg);
      return;
    }
  }
  function onUploaderMessage(msg) {
    if(msg.type === 'StatusUpdate') {
      ProcessStatusUpdate(msg);
      return;
    }
  }
  function onStatusMessage(msg) {
    if(msg.type !== 'CompiledStatus') return;

    //take the status message and push to IoT
    //TODO: also make available to bluetooth config util??
    const iotProcess = FindChildProcess(childProcesses, 'iot');
    iotProcess.send({
      type: 'CompiledStatus',
      payload: msg.payload,
    });
  }
  function onIotShadowMessage(msg) {
    if(msg.type === 'StatusUpdate') {
      ProcessStatusUpdate(msg);
      return;
    }
    //if new device state - broadcast it to everyone
    if(msg.type === 'DeviceStateChanged') {
      _.each(childProcesses, function(cp) {
        if(!cp.connected) return;
        cp.send({
          type:'DeviceStateChanged',
          payload: msg.payload
        });
      }); 
    }
  }


  function mainInitWithConfig(config) {
      localConfig = config;
      logger = bunyan.createLogger({
        name: 'main-log',
        deviceId: localConfig.deviceId,
        streams: [{
            type: 'rotating-file',
            level: 'info',
            path: path.join(config.loggingPath, 'main-log.log'),
            period: '1d',   // daily rotation
            count: 3        // keep 3 back copies
        },
        {
          stream: process.stdout,
          level: 'debug'
        }]
      });
  }
  function mainCreateChildProcesses() {
      //create child processes
      //spawn the encoder
      let encoderProcess = childProcessDebug.fork('./encoder/index.js');
      encoderProcess.on('message', onEncoderMessage);
      childProcesses.push(encoderProcess);

      //start aws iot shadow
      let iotShadowProcess = childProcessDebug.fork('./iot-shadow/index.js');
      iotShadowProcess.on('message', onIotShadowMessage);
      childProcesses.push(iotShadowProcess);

      //start monitoring process
      let statusProcess = childProcessDebug.fork('./status/index.js');
      statusProcess.on('message', onStatusMessage);
      childProcesses.push(statusProcess);

      //start uploader process
      let uploaderProcess = childProcessDebug.fork('./uploader/index.js');
      uploaderProcess.on('message', onUploaderMessage);
      childProcesses.push(uploaderProcess);
  }
  function mainInitProcesses() {
      //init the processes
      _.each(childProcesses, function(cp) {
        cp.send({
        type:'Init',
        payload: localConfig
        });
      });
  }

  // main process run path
  localConfigReader.load()
    .then(mainInitWithConfig)
    .then(mainCreateChildProcesses)
    .then(mainInitProcesses)
    .done(function() {
      }, function(err) {
        if(logger) {
          logger.error(err);
        }else {
          console.log(err);
        }
      });

})()

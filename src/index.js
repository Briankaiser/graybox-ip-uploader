const fork = require('child_process').fork;
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

  function receivedEncoderMessage(msg)
  {
    console.log(msg);
  }


  function mainInitWithConfig(config) {
      localConfig = config;
      logger = bunyan.createLogger({
        name: 'main-log',
        deviceId: localConfig.deviceId,
        streams: [{
            type: 'rotating-file',
            path: path.join(config.loggingPath, 'main-log.log'),
            period: '1d',   // daily rotation
            count: 3        // keep 3 back copies
        },
        {
          stream: process.stderr,
          level: "debug"
        }]
      });
  }
  function mainCreateChildProcesses() {
      //create child processes
      //spawn the encoder
      let encoderProcess = childProcessDebug.fork('./encoder/index.js');
      encoderProcess.on('message', receivedEncoderMessage);
      childProcesses.push(encoderProcess);

      //start monitoring process
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
  function mainInitIoT() {
      //setup AWS IoT and get initial state
      //send fake device state for now
      setTimeout(function() {
        _.each(childProcesses, function(cp) {
          if(!cp.connected) return;
          cp.send({
            type:'DeviceStateChanged',
            payload: {
              encoderEnabled: true,
            }
          });
        });
      }, 5000);
  }

  // main process run path
  localConfigReader.load()
    .then(mainInitWithConfig)
    .then(mainCreateChildProcesses)
    .then(mainInitProcesses)
    .then(mainInitIoT)
    .done(function() {
      }, function(err) {
        if(logger) {
          logger.error(err);
        }else {
          console.log(err);
        }
      });



  //get local IP information. Camera info? probably on a timer/loop. setInterval(). actually just report device status in general here

  //status ping using SetInterval. it writes a log message with status (and back to IoT) on every ping
  //as it received IPC from other nodes it keeps 'current' status

  //spawn the uploader process

  //spawn the cleanup process

  //listen for messages and re-broadcast to child processes

})()

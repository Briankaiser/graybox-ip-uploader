const bunyan = require('bunyan');
const path = require('path');
const os = require('os');
const fs = require('fs');
const dns = require('dns');
const deferred = require('deferred');
const _ = require('lodash');

const promisify = deferred.promisify;
const readDirAsync = promisify(fs.readdir);
const unlinkAsync = promisify(fs.unlink);
const lookupAsync = promisify(dns.lookup);


(function() {
  let localConfig = {};
  let deviceState = {};
  let currentStatus = {};
  let logger;
  let currentExternalIp = '';


  function init(config) {
    localConfig = config;
    logger = bunyan.createLogger({
      name: 'status-log',
      deviceId: localConfig.deviceId,
      streams: [{
          type: 'rotating-file',
          level: 'info',
          path: path.join(config.loggingPath, 'status-log.log'),
          period: '1d',   // daily rotation
          count: 3        // keep 3 back copies
      },
      {
        stream: process.stdout,
        level: 'debug'
      }]
    });

  }

  function UpdateStatus(payload) {
    currentStatus = _.merge(currentStatus, payload);
  }

  function ProcessUpdatedDeviceState(newState) {
    let prevState = deviceState;
    deviceState = newState;

  }

  process.on('message', function(msg) {
    if (!msg) return;

    if (msg.type === 'Init') {
      init(msg.payload);
    } else if (msg.type === 'DeviceStateChanged') {
      ProcessUpdatedDeviceState(msg.payload);
    } else if(msg.type === 'StatusUpdate') {
      UpdateStatus(msg.payload);
    }
  })

  function GatherInternalStatuses() {
    // get local IPs
    const internalIps = 
      _.chain(os.networkInterfaces())
      .flatMap()
      .filter(function(ni) {
        return !ni.internal && ni.family === 'IPv4';
      }).map(function(ni) {
        return ni.address
      }).join(', ')
      .value();

      lookupAsync('myip.opendns.com',{family: 4})
      .then(function(addresses) {
        currentExternalIp = addresses[0];
      })
      .done(function() {

      }, function(err) {

      });

    // get external IP
    // get CPU
    // get disk percentage on tmp drive
    // get camera info? connection status? stream status?
    const statusObj = {
      deviceId: localConfig.deviceId,
      internalIps: internalIps,
      externalIp: currentExternalIp,
      freeMemory: os.freemem(),
      loadAverage: _.join(os.loadavg(), ', '),
    };
    currentStatus = _.merge(currentStatus, statusObj);
  }

  let statusInterval = setInterval(function() {
    //update internal status
    GatherInternalStatuses();
    process.send({
      type: 'CompiledStatus',
      payload: currentStatus
    });
  }, 10000);

})();
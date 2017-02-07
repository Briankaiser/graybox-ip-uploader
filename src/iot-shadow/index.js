const bunyan = require('bunyan');
const path = require('path');
const os = require('os');
const thingShadow = require('aws-iot-device-sdk').thingShadow;
const _ = require('lodash');


(function() {
  let localConfig = {};
  let deviceState = {};
  let logger;
  let connected = false;

  function initIotShadowConnection() {
    //TODO: very host, keys exist, deviceId exists

    console.log(path.resolve('../certs', 'thing.private.key'));
    const thingShadows = thingShadow({
      keyPath: path.resolve('../certs', 'thing.private.key'),
      certPath: path.resolve('../certs',  'thing.cert.pem'),
      caPath: path.resolve('../certs',  'root-ca.crt'),
      clientId: localConfig.deviceId,
      region: 'us-east-1',
      baseReconnectTimeMs: 4000,
      keepAlive: 30,
      delay: 4000,
      protocol: 'mqtts',
      host: localConfig.iotHostname,
      debug: true
    });
    thingShadows.register(localConfig.deviceId, {
        persistentSubscribe: true
    });
    thingShadows.on('connect', function() {
      logger.info('aws iot connected');
      connected = true;
      setTimeout(function(){
        thingShadows.get(localConfig.deviceId); //trigger an initial get
      }, 1000);
    });
    thingShadows.on('close', function() {
      logger.info('aws iot closed');
      connected = false;
      thingShadows.unregister(localConfig.deviceId);
    });
    thingShadows.on('reconnect', function() {
      thingShadows.register(localConfig.deviceId, {
        persistentSubscribe: true
      });
    });
    thingShadows.on('message', function(topic, payload) {
      logger.info('aws iot message', topic, payload);
    });
    thingShadows.on('delta', function(thingName, stateObject) {
      logger.info('aws iot delta', thingName, stateObject);
      //TODO: modify the device state and broadcast
      process.send({
          type: 'DeviceStateChanged',
          payload: _.merge(deviceState, stateObject.state),
      });
    });
    thingShadows.on('status', function(thingName, statusType, clientToken, stateObject) {
      logger.info('awsstatus', thingName, statusType, clientToken, stateObject);
      if(statusType === 'accepted' && thingName === localConfig.deviceId) {
        //set device state
        process.send({
          type: 'DeviceStateChanged',
          payload: stateObject.state.desired,
        });
      }
    });
  }

  function init(config) {
    localConfig = config;
    logger = bunyan.createLogger({
      name: 'iot-log',
      deviceId: localConfig.deviceId,
      streams: [{
          type: 'rotating-file',
          path: path.join(config.loggingPath, 'iot-log.log'),
          period: '1d',   // daily rotation
          count: 3        // keep 3 back copies
      },
      {
        stream: process.stderr,
        level: "debug"
      }]
    });

    initIotShadowConnection();
  }

  function ProcessUpdatedDeviceState(state) {
    deviceState = state;
  }
  function buildIotStatusMessage() {
    return {
      type: 'StatusUpdate',
      payload: {
        iotConnected: connected,  
      }
    }
  }

  process.on('message', function(msg)
  {
    if (!msg) return;

    if (msg.type === 'Init') {
      init(msg.payload);
    } else if (msg.type === 'DeviceStateChanged') {
      ProcessUpdatedDeviceState(msg.payload);
    }
  })



  let statusInterval = setInterval(function()
  {
    process.send(buildIotStatusMessage());
  }, 10000);


})();
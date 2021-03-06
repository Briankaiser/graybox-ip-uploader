const bunyan = require('bunyan')
const fs = require('fs')
const path = require('path')
const thingShadow = require('aws-iot-device-sdk').thingShadow
const _ = require('lodash')
const deferred = require('deferred')
const yaml = require('js-yaml')

const promisify = deferred.promisify
const readFileAsync = promisify(fs.readFile)
const writeFileAsync = promisify(fs.writeFile)

;(function () {
  let localConfig = {}
  let deviceState = {}
  let logger
  let connected = false
  let thingShadows
  let lastUpdateClientToken

  function initIotShadowConnection () {
    // TODO: verify host, keys exist, deviceId exists

    thingShadows = thingShadow({
      keyPath: path.resolve('../certs', 'thing.private.key'),
      certPath: path.resolve('../certs', 'thing.cert.pem'),
      caPath: path.resolve('../certs', 'root-ca.crt'),
      clientId: localConfig.deviceId,
      region: 'us-east-1',
      baseReconnectTimeMs: 4000,
      keepAlive: 30,
      delay: 4000,
      protocol: 'mqtts',
      host: localConfig.iotHostname,
      debug: true
    })
    thingShadows.register(localConfig.deviceId, {
      persistentSubscribe: true
    })

    thingShadows.on('connect', function () {
      logger.info('aws iot connected')

      setTimeout(function () {
        thingShadows.get(localConfig.deviceId) // trigger an initial get
      }, 3000)
    })
    thingShadows.on('close', function () {
      logger.info('aws iot closed')
      connected = false
    })
    thingShadows.on('reconnect', function (a, b) {
      logger.info('aws iot reconnect attempt')
    })
    thingShadows.on('message', function (topic, payload) {
      logger.info('aws iot message', topic, payload)
    })
    thingShadows.on('delta', function (thingName, stateObject) {
      // logger.debug('aws iot delta', thingName, stateObject)
      connected = true
      process.send({
        type: 'DeviceStateChanged',
        payload: _.merge({}, deviceState, stateObject.state)
      })
    })
    thingShadows.on('status', function (thingName, statusType, clientToken, stateObject) {
      connected = true
      // if this is a response to our update request - then log it and return
      // the 'delta' handler will process the update
      if (clientToken === lastUpdateClientToken) {
        lastUpdateClientToken = null
        logger.debug('update request successful', clientToken)
        process.send({
          type: 'DeviceUpdateAwknowledged',
          payload: null
        })
        return
      }
      logger.debug('awsstatus', thingName, statusType, clientToken, stateObject)
      if (statusType === 'accepted' && thingName === localConfig.deviceId) {
        // set device state
        process.send({
          type: 'DeviceStateChanged',
          payload: _.merge({}, deviceState, stateObject.state.desired)
        })
      }
    })
    thingShadows.on('error', function (err) {
      if (err.code === 'ENOTFOUND') {
        connected = false
        logger.debug({err: err}, 'Remote host not found. Probably no internet connection')
        return
      }

      logger.error({err: err})
    })
  }

  function startOfflineStateRetrievalTimer () {
    // if we don't get the state in 30s, then assume we can't connect
    // and attempt to load the offline cached state
    setTimeout(function () {
      if (!_.isEmpty(deviceState)) {
        return
      }

      const cachedConfigPath = path.join(localConfig.tmpDirectory, 'cached-device-state.yaml')
      logger.info({configPath: cachedConfigPath}, 'Loading cached device state.')
      readFileAsync(cachedConfigPath, 'utf8')
        .then(function (result) {
          return yaml.safeLoad(result)
        }).done(function (config) {
          // set device state
          process.send({
            type: 'DeviceStateChanged',
            payload: _.merge({}, config)
          })
        }, function (err) {
          logger.warn({configPath: cachedConfigPath, err: err}, 'Attempted to load cached state and it failed')
        })
    }, 30000)
  }

  function PostCompiledStatusToIoT (payload) {
    if (!connected) return

    const strPayload = JSON.stringify(payload)
    thingShadows.publish('device-status', strPayload)

    lastUpdateClientToken = thingShadows.update(localConfig.deviceId, {
      state: {
        reported: payload
      }
    })
    // logger.debug({payload: payload, clientToken: lastUpdateClientToken}, 'sending device state reported update')
  }

  function init (config) {
    localConfig = config
    logger = bunyan.createLogger({
      name: 'iot-log',
      deviceId: localConfig.deviceId,
      streams: [{
        type: 'rotating-file',
        level: 'info',
        path: path.join(config.loggingPath, 'iot-log.log'),
        period: '1d',   // daily rotation
        count: 3        // keep 3 back copies
      },
      {
        stream: process.stdout,
        level: 'info'
      }]
    })

    initIotShadowConnection()

    startOfflineStateRetrievalTimer()
  }

  function HandleRebroadcastRequest () {
    process.send({
      type: 'DeviceStateChanged',
      payload: deviceState
    })
  }

  function HandleRequestDeviceStateChange (payload) {
    // TODO: should have some better retry logic around thingShadow
    lastUpdateClientToken = thingShadows.update(localConfig.deviceId, {
      state: {
        desired: payload
      }
    })
    logger.debug({payload: payload, clientToken: lastUpdateClientToken}, 'sending device state update request')
  }

  function ProcessUpdatedDeviceState (state) {
    deviceState = state
    // save cached version to disk
    if (!_.isEmpty(deviceState)) {
      const cachedConfigPath = path.join(localConfig.tmpDirectory, 'cached-device-state.yaml')
      const yamlState = yaml.safeDump(deviceState)
      writeFileAsync(cachedConfigPath, yamlState).done()
    }
  }

  function buildIotStatusMessage () {
    return {
      type: 'StatusUpdate',
      payload: {
        iotConnected: connected
      }
    }
  }

  process.on('message', function (msg) {
    if (!msg) return

    if (msg.type === 'Init') {
      init(msg.payload)
    } else if (msg.type === 'DeviceStateChanged') {
      ProcessUpdatedDeviceState(msg.payload)
    } else if (msg.type === 'CompiledStatus') {
      PostCompiledStatusToIoT(msg.payload)
    } else if (msg.type === 'RebroadcastRequest') {
      HandleRebroadcastRequest()
    } else if (msg.type === 'RequestDeviceStateChange') {
      HandleRequestDeviceStateChange(msg.payload)
    }
  })

  setInterval(function () {
    process.send(buildIotStatusMessage())
  }, 10000)
})()

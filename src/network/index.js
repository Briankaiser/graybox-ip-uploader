const bunyan = require('bunyan')
const path = require('path')
const deferred = require('deferred')
// const async = require('async')
// const _ = require('lodash')

// const promisify = deferred.promisify
// const lookupAsync = promisify(dns.lookup)

;(function () {
  let localConfig = {}
  let deviceState = {}
  let logger
  let statusInterval

  process.on('uncaughtException', (err) => {
    console.error('unhandled status exception', err)
    process.exit(1)
  })
  process.on('exit', function () {
    if (statusInterval) {
      clearInterval(statusInterval)
    }
  })

  function init (config) {
    localConfig = config
    logger = bunyan.createLogger({
      name: 'network-log',
      deviceId: localConfig.deviceId,
      streams: [{
        type: 'rotating-file',
        level: 'info',
        path: path.join(config.loggingPath, 'network-log.log'),
        period: '1d',   // daily rotation
        count: 3        // keep 3 back copies
      },
      {
        stream: process.stdout,
        level: 'debug'
      }]
    })
  }

  function ProcessUpdatedDeviceState (newState) {
    debugger
    const prevState = deviceState
    deviceState = newState
    // if proxy should be on and the camera ip or proxy state changed - then turn it on
    if (deviceState.cameraIp && deviceState.localCameraProxy && (deviceState.cameraIp !== prevState.cameraIp || deviceState.localCameraProxy !== prevState.localCameraProxy)) {
      logger.info('turning proxy on')
    } else if (!deviceState.localCameraProxy && (deviceState.localCameraProxy !== prevState.localCameraProxy)) {
      // if the proxy is to be turned off (and it was on) - then turn it off
      logger.info('turning proxy off')
    }
  }

  process.on('message', function (msg) {
    if (!msg) return

    if (msg.type === 'Init') {
      init(msg.payload)
    } else if (msg.type === 'DeviceStateChanged') {
      ProcessUpdatedDeviceState(msg.payload)
    }
  })

  setInterval(function () {
    // update internal status
  }, 10000)
})()

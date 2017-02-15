const bunyan = require('bunyan')
const path = require('path')
const os = require('os')
const dns = require('dns')
const deferred = require('deferred')
const ping = require('ping')
const _ = require('lodash')

const promisify = deferred.promisify
const lookupAsync = promisify(dns.lookup)


;(function () {
  let localConfig = {}
  let deviceState = {}
  let currentStatus = {}
  let logger
  let currentExternalIp = ''
  let currentCameraPing = false
  let currentInternalIps = ''



  function init (config) {
    localConfig = config
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
    })
  }

  function UpdateStatus (payload) {
    currentStatus = _.merge(currentStatus, payload)
  }

  function ProcessUpdatedDeviceState (newState) {
    deviceState = newState
  }

  process.on('message', function (msg) {
    if (!msg) return

    if (msg.type === 'Init') {
      init(msg.payload)
    } else if (msg.type === 'DeviceStateChanged') {
      ProcessUpdatedDeviceState(msg.payload)
    } else if (msg.type === 'StatusUpdate') {
      UpdateStatus(msg.payload)
    }
  })

  function GatherInternalStatuses () {
      // look up external IP
    return lookupAsync('myip.opendns.com', {family: 4})
      .then(function (addresses) {
        currentExternalIp = addresses[0]
      })
      .then(function () {
        // camera ping
        if (deviceState && !!deviceState.cameraIp) {
          return ping.promise.probe(deviceState.cameraIp)
        }
      })
      .then(function (cameraPingResult) {
        if (!cameraPingResult) return
        // record camera ping
        currentCameraPing = cameraPingResult.alive
      })
      .then(function () {
        // get local IPs
        currentInternalIps =
          _.chain(os.networkInterfaces())
          .flatMap()
          .filter(function (ni) {
            return !ni.internal && ni.family === 'IPv4' && !ni.address.startsWith('169.254.')
          }).map(function (ni) {
            return ni.address
          }).join(', ')
          .value()
      })
      .then(function () {
        const statusObj = {
          deviceId: localConfig.deviceId,
          internalIps: currentInternalIps,
          externalIp: currentExternalIp,
          freeMemory: os.freemem() / (1024 * 1024),
          loadAverage: _.join(os.loadavg(), ', '),
          cameraPing: currentCameraPing
        }
        return _.merge(currentStatus, statusObj)
      })
  }

  setInterval(function () {
    // update internal status
    GatherInternalStatuses().done(function (fullStatus) {
      process.send({
        type: 'CompiledStatus',
        payload: currentStatus
      })
    }, function (err) {
      logger.warn(err, 'error compiling status')
    })
  }, 10000)
})()

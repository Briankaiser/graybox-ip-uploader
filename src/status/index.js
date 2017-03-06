const bunyan = require('bunyan')
const path = require('path')
const os = require('os')
// const dns = require('dns')
const deferred = require('deferred')
const async = require('async')
const ping = require('ping')
const _ = require('lodash')
const http = require('http')

const IP_LOOKUP_URL = 'http://whatismyip.akamai.com/'

;(function () {
  let localConfig = {}
  let deviceState = {}
  let currentStatus = {}
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
    let d = deferred()
    // look up external IP
    const tasks = {
      externalIpTask: async.timeout(function (callback) {
        http.get(IP_LOOKUP_URL, function (res) {
          res.setEncoding('utf8')
          res.on('data', function (chunk) {
            callback(null, chunk.trim())
          })
        }).on('error', function (e) {
          callback(e)
        })
      }, 2000),
      cameraPingTask: async.timeout(function (callback) {
        // camera ping
        if (!deviceState || !deviceState.cameraIp) {
          callback(null, false)
        }
        ping.promise.probe(deviceState.cameraIp).then(function (cameraPingResult) {
          callback(null, (cameraPingResult !== null && cameraPingResult.alive === true) ? true : false)
        })
      }, 2000),
      internalIpsTask: function (callback) {
        // get local IPs
        let currentInternalIps =
          _.chain(os.networkInterfaces())
          .flatMap()
          .filter(function (ni) {
            return !ni.internal && ni.family === 'IPv4'
          }).map(function (ni) {
            return ni.address
          }).join(', ')
          .value()
        callback(null, currentInternalIps)
      }
    }

    async.parallel(async.reflectAll(tasks),
      function (err, results) { // eslint-disable-line handle-callback-err
        const statusObj = {
          deviceId: localConfig.deviceId,
          internalIps: results.internalIpsTask.value,
          externalIp: results.externalIpTask.value,
          freeMemory: os.freemem() / (1024 * 1024),
          loadAverage: _.join(os.loadavg(), ', '),
          cameraPing: results.cameraPingTask.value || false
        }
        d.resolve(_.merge(currentStatus, statusObj))
      })

    return d.promise
  }

  setInterval(function () {
    // update internal status
    statusInterval = GatherInternalStatuses().done(function (fullStatus) {
      process.send({
        type: 'CompiledStatus',
        payload: fullStatus
      })
    }, function (err) {
      logger.warn(err, 'error compiling status')
    })
  }, 30000)
})()

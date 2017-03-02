const bunyan = require('bunyan')
const path = require('path')
const fs = require('fs')
const deferred = require('deferred')
const childProcess = require('child_process')

const IPTABLES_TABLE = 'nat'
const IPTABLES_CHAIN = 'PREROUTING'
const POST_CHAIN = 'POSTROUTING'
const IP_FORWARDING_PATH = '/proc/sys/net/ipv4/ip_forward'

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

  function setIpForwarding (isEnabled) {
    let d = deferred()
    const toWrite = isEnabled ? '1' : '0'
    fs.writeFile(IP_FORWARDING_PATH, toWrite, (err) => {
      if (err) {
        d.reject(err)
      } else {
        d.resolve()
      }
    })

    return d.promise
  }

  function executeIpTablesCommand (args) {
    let d = deferred()
    const proc = childProcess.spawn('iptables', args)
    proc.on('close', (code) => {
      if (code !== 0) {
        d.reject(new Error(`Process returned exit code: ${code}`))
      } else {
        d.resolve()
      }
    })
    return d.promise
  }
  function executeFlushChain () {
    const args = [
      '-t',
      IPTABLES_TABLE,
      '-F'
    ]
    return executeIpTablesCommand(args)
  }
  function executeAddCameraForwardPort (port) {
    const cameraIpAndPort = deviceState.cameraIp + ':' + port
    const args = [
      '-t',
      IPTABLES_TABLE,
      '-A',
      IPTABLES_CHAIN,
      '-i', // interface to forward from
      'eth0',
      '-p', // protocol
      'tcp',
      '--dport', // port to route from (destination of original request)
      port,
      '-j', // jump. destination routing area?
      'DNAT',
      '--to-destination',
      cameraIpAndPort
    ]
    return executeIpTablesCommand(args)
  }
  function executeAddReturnMasquerade () {
    const args = [
      '-t',
      IPTABLES_TABLE,
      '-A',
      POST_CHAIN,
      '-j', // jump. destination routing area?
      'MASQUERADE'
    ]
    return executeIpTablesCommand(args)
  }

  function turnProxyOff () {
    logger.info('turning proxy off')
    setIpForwarding(false)
    .then(() => executeFlushChain())
    .done(
      function () {
        logger.info('successfully flushed proxy chain')
      },
      function (err) {
        logger.warn(err, 'error flushing network chain')
      }
    )
  }
  function turnProxyOn () {
    logger.info('turning proxy on')
    setIpForwarding(true)
    .then(() => executeFlushChain())
    .then(() => executeAddCameraForwardPort(80))
    .then(() => executeAddCameraForwardPort(554))
    .then(() => executeAddCameraForwardPort(8091))
    .then(() => executeAddReturnMasquerade())
    .done(function () {
      logger.info('successfully created proxy chain')
    }, function (err) {
      logger.warn(err, 'error creating network chain')
    })
  }

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
    const prevState = deviceState
    deviceState = newState
    if (deviceState.cameraIp && deviceState.localCameraProxy && (deviceState.cameraIp !== prevState.cameraIp || deviceState.localCameraProxy !== prevState.localCameraProxy)) {
      // if proxy should be on and the camera ip or proxy state changed - then turn it on
      turnProxyOn()
    } else if (!deviceState.localCameraProxy && (deviceState.localCameraProxy !== prevState.localCameraProxy)) {
      // if the proxy is to be turned off (and it was on) - then turn it off
      turnProxyOff()
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

  // statusInterval = setInterval(function () {
  //   // update internal status
  // }, 10000)
})()

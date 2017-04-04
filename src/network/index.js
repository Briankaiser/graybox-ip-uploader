const bunyan = require('bunyan')
const path = require('path')
const fs = require('fs')
const deferred = require('deferred')
const childProcess = require('child_process')
const ngrok = require('ngrok')

const IPTABLES_TABLE = 'nat'
const IPTABLES_CHAIN = 'PREROUTING'
const POST_CHAIN = 'POSTROUTING'
const IP_FORWARDING_PATH = '/proc/sys/net/ipv4/ip_forward'

;(function () {
  let localConfig = {}
  let deviceState = {}
  let logger
  let statusInterval
  let ngrokRunning, ngrokStarting, ngrokSshAddress
  let firewallRunning

  process.on('uncaughtException', (err) => {
    console.error('unhandled status exception', err)
    process.exit(1)
  })
  process.on('exit', function () {
    if (statusInterval) {
      clearInterval(statusInterval)
    }
  })

  function triggerNetworkStatusUpdate () {
    // TODO: do we need to report ufw status back?
    const msg = {
      type: 'StatusUpdate',
      payload: {
        isNgrokRunning: ngrokRunning,
        ngrokSshAddress: ngrokSshAddress
      }
    }
    process.send(msg)
  }

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
    .then(() => executeAddCameraForwardPort(3702)) // ONVIF
    .then(() => executeAddReturnMasquerade())
    .done(function () {
      logger.info('successfully created proxy chain')
    }, function (err) {
      logger.warn(err, 'error creating network chain')
    })
  }

  function turnNgrokOn () {
    let ngrokRegion
    switch (deviceState.awsRegion) {
      case 'eu-west-1':
      case 'eu-west-2':
      case 'eu-central-1': {
        ngrokRegion = 'eu'
        break
      }
      case 'ap-southeast-2': {
        ngrokRegion = 'au'
        break
      }
      case 'ap-south-1':
      case 'ap-northeast-2':
      case 'ap-southeast-1':
      case 'ap-northeast-1': {
        ngrokRegion = 'ap'
        break
      }
      default: {
        ngrokRegion = 'us'
        break
      }
    }
    ngrokStarting = true
    logger.debug({
      region: ngrokRegion
    }, 'starting ngrok')

    ngrok.connect({
      proto: 'tcp',
      addr: 22,
      authtoken: deviceState.ngrokAuthtoken,
      region: ngrokRegion,
      bind_tls: false
    }, function (err, url) {
      ngrokStarting = false
      if (err) {
        ngrokRunning = false
        logger.error({
          region: ngrokRegion,
          err: err
        }, 'failed ngrok')
        console.log(err)
      } else {
        logger.info({
          region: ngrokRegion,
          address: url
        }, 'started ngrok')
        ngrokRunning = true
        ngrokSshAddress = url
      }

      triggerNetworkStatusUpdate()
    })
  }
  function turnNgrokOff () {
    ngrok.disconnect()
    ngrokRunning = false
    ngrokStarting = false
    ngrokSshAddress = ''
    logger.info('stopped ngrok')
    triggerNetworkStatusUpdate()
  }

  function turnFirewallOn () {
    logger.info('turning firewall on')
    childProcess.execFile('ufw', ['--force', 'enable'], {
      timeout: 5000
    }, function (err, stdout, stderr) {
      if (err) {
        logger.error(err, 'error turning on firewall')
        console.log(stdout, stderr)
        return
      }
      firewallRunning = true
    })
  }
  function turnFirewallOff () {
    logger.info('turning firewall off')
    childProcess.execFile('ufw', ['disable'], {
      timeout: 5000
    }, function (err, stdout, stderr) {
      if (err) {
        logger.error(err, 'error turning off firewall')
        console.log(stdout, stderr)
        return
      }
      firewallRunning = false
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

    if (deviceState.ngrokEnabled && deviceState.ngrokAuthtoken && !ngrokRunning && !ngrokStarting) {
      turnNgrokOn()
    } else if (!deviceState.ngrokEnabled && ngrokRunning) {
      turnNgrokOff()
    }

    if (deviceState.firewallEnabled && !firewallRunning) {
      turnFirewallOn()
    } else if (!deviceState.firewallEnabled && firewallRunning !== false) {
      turnFirewallOff()
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

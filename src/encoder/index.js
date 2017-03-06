const ffmpeg = require('fluent-ffmpeg')
const bunyan = require('bunyan')
const path = require('path')
const buildUrl = require('build-url')
const mkdirp = require('mkdirp')
const _ = require('lodash')
const http = require('http')
const fs = require('fs')

;(function () {
  let localConfig = {}
  let deviceState = {}
  let ffmpegProcess
  let logger
  let ignoreNextError = false
  let snapshotInterval

  process.on('exit', function () {
    if (ffmpegProcess) {
      ignoreNextError = true
      ffmpegProcess.kill()
      ffmpegProcess = null
    }
    if (snapshotInterval) {
      clearInterval(snapshotInterval)
    }
  })

  function getInput (config, state) {
    if (!_.isEmpty(config.inputSourceOverride)) {
      return config.inputSourceOverride
    } else {
      // TODO: verify cameraIp, cameraPort, rtmpStreamPath
      let baseUrl = 'rtsp://' + state.cameraIp + ':' + state.cameraPort
      let fullUrl = buildUrl(baseUrl, {
        path: state.rtmpStreamPath
      })
      return fullUrl
    }
  }

  function startEncoder () {
    if (ffmpegProcess) return // don't allow double run
    // start ffmpeg
    const outputFile = path.join(localConfig.tmpDirectory, '/video/', 'output%Y-%m-%d_%H-%M-%S.ts')
    const inputFile = getInput(localConfig, deviceState)
    ignoreNextError = false
    let inputOptions = [
      '-buffer_size 64M',
      '-reorder_queue_size 64'
    ]
    if (deviceState.forceRtspTcp) {
      inputOptions.push(' -rtsp_transport tcp')
    }
    let outputOptions = [
      '-segment_time 8',
      '-reset_timestamps 1',
      '-strftime 1',
      '-segment_start_number 1',
      '-segment_time_delta 0.3',
      // '-segment_format mp4',
      '-c copy'
    ]
    if (!deviceState.audioFromCameraEnabled) {
      outputOptions.push('-an')
    }
    ffmpegProcess = ffmpeg(inputFile)
                          .inputOptions(inputOptions)
                          .format('segment')
                          .outputOptions(outputOptions)
                          .on('start', function (commandLine) {
                            logger.info({
                              input: inputFile,
                              output: outputFile,
                              commandLine: commandLine
                            }, 'ffmpeg started.')
                          })
                          .on('error', function (err, stdout, stderr) {
                            // if graceful exit (ie remote encoder stop)
                            if (ignoreNextError) {
                              ignoreNextError = false
                              return
                            }

                            logger.info({
                              input: inputFile,
                              output: outputFile,
                              error: err
                            }, 'ffmpeg error')
                            // attempt to restart ffmpeg if applicable
                            if (deviceState.encoderEnabled) {
                              ffmpegProcess = null
                              setTimeout(function () {
                                startEncoder()
                              }, 5000)
                            }
                          })
                          .on('end', function () {
                            logger.info({
                              input: inputFile,
                              output: outputFile
                            }, 'ffmpeg ended.')

                            // attempt to restart ffmpeg if applicable
                            if (deviceState.encoderEnabled) {
                              ffmpegProcess = null
                              setTimeout(function () {
                                startEncoder()
                              }, 10000)
                            }
                          })
                          .on('stderr', function (stderrLine) {
                            console.error(stderrLine)
                          })
                          .save(outputFile)
  }
  function stopEncoder () {
    if (ffmpegProcess) {
      ignoreNextError = true
      ffmpegProcess.kill()
      ffmpegProcess = null
    }
  }

  function startSnapshot () {
    if (snapshotInterval) return
    logger.info('Starting snapshot interval')
    snapshotInterval = setInterval(takeSnapshot, 10000)
  }

  function stopSnapshot () {
    if (!snapshotInterval) return
    logger.info('Stopping snapshot interval')
    clearInterval(snapshotInterval)
  }

  function takeSnapshot () {
    if (!deviceState.snapshotEnabled || !deviceState.snapshotPath || !deviceState.snapshotPort) {
      return
    }
    const utcms = new Date().getTime()
    const imagePath = path.join(localConfig.tmpDirectory, '/video/', 'snapshot-' + utcms + '.jpg')

    logger.debug(imagePath, 'taking snapshot')

    const file = fs.createWriteStream(imagePath)
    http.get({
      protocol: 'http:',
      hostname: deviceState.cameraIp,
      port: deviceState.snapshotPort,
      path: deviceState.snapshotPath,
      timeout: 2000
    }, function (response) {
      response.pipe(file)
      file.on('finish', function () {
        file.close()
      })
    }).on('error', function (err) {
      console.log(err)
      fs.unlink(imagePath)
    })
  }

  function init (config) {
    localConfig = config
    logger = bunyan.createLogger({
      name: 'encoder-log',
      deviceId: localConfig.deviceId,
      streams: [{
        type: 'rotating-file',
        level: 'info',
        path: path.join(config.loggingPath, 'encoder-log.log'),
        period: '1d',   // daily rotation
        count: 3        // keep 3 back copies
      },
      {
        stream: process.stdout,
        level: 'debug'
      }]
    })
    mkdirp(path.join(localConfig.tmpDirectory, '/video/'))
  }

  function ProcessUpdatedDeviceState (state) {
    deviceState = state
    // if it should be running, and it isn't current running - start it
    if (deviceState.encoderEnabled && !ffmpegProcess) {
      startEncoder()
    // if it should be off - but it is currently running - stop it
    } else if (!deviceState.encoderEnabled && !!ffmpegProcess) {
      stopEncoder()
    }

    if (deviceState.snapshotEnabled && !snapshotInterval) {
      startSnapshot()
    } else if (!deviceState.snapshotEnabled && snapshotInterval) {
      stopSnapshot()
    }
  }
  function buildEncoderStatusMessage () {
    return {
      type: 'StatusUpdate',
      payload: {
        ffmpegRunning: !!ffmpegProcess
      }
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
    process.send(buildEncoderStatusMessage())
  }, 10000)
})()


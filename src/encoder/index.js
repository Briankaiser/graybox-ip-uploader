const ffmpeg = require('fluent-ffmpeg')
const bunyan = require('bunyan')
const path = require('path')
const buildUrl = require('build-url')
const mkdirp = require('mkdirp')
const _ = require('lodash')
const http = require('http')
const fs = require('fs')
const moment = require('moment')

const SNAPSHOT_INTERVAL = 10 * 1000
const SCHEDULE_CHECK_INTERVAL = 10 * 1000

;(function () {
  let localConfig = {}
  let deviceState = {}
  let ffmpegProcess
  let logger
  let ignoreNextError = false
  let snapshotInterval
  let scheduledRecordingActive
  let scheduledRecordingsInterval

  let lastFrame, potentialStallCount

  process.on('exit', function () {
    if (ffmpegProcess) {
      ignoreNextError = true
      ffmpegProcess.kill()
      ffmpegProcess = null
    }
    if (snapshotInterval) {
      clearInterval(snapshotInterval)
    }
    if (scheduledRecordingsInterval) {
      clearInterval(scheduledRecordingsInterval)
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
    let videoExt = '.ts' // default extension
    if (!_.isEmpty(deviceState.overrideVideoExt)) {
      videoExt = deviceState.overrideVideoExt
    }
    const outputFile = path.join(localConfig.tmpDirectory, '/video/', 'output%Y-%m-%d_%H-%M-%S' + videoExt)
    const inputFile = getInput(localConfig, deviceState)
    potentialStallCount = 0
    ignoreNextError = false
    let inputOptions = [
      '-buffer_size 4M',
      '-rtbufsize 4M',
      '-reorder_queue_size 64',
      '-stimeout 5000000', // (socket timeout) in microseconds
      '-thread_queue_size 1024'
    ]
    if (deviceState.forceRtspTcp) {
      inputOptions.push('-rtsp_transport tcp')
    }

    let outputOptions = [
      '-map 0:v:0',
      '-segment_time 8',
      '-reset_timestamps 1',
      '-strftime 1',
      // '-segment_start_number 1',
      '-segment_time_delta 0.3'
      // '-segment_format mp4',
      // '-c copy'
    ]
    if (!deviceState.audioFromCameraEnabled && !deviceState.useExternalMicAudio) {
      outputOptions.push('-an')
    }
    ffmpegProcess = ffmpeg({
      // logger: logger
    })
    .input(inputFile)
    .inputOptions(inputOptions)

    // add external usb mic input
    // can not be combined with in camera audio (audioFromCameraEnabled)
    // only works on linux at this time
    if (deviceState.useExternalMicAudio && !deviceState.audioFromCameraEnabled && process.platform === 'linux') {
      ffmpegProcess = ffmpegProcess
                        .input('default:CARD=Device')
                        .inputFormat('alsa')
                        .inputOptions([
                          '-ac 1',
                          '-thread_queue_size 1024'
                        ])
                        .audioCodec('aac')
      //   .audioFilters('volume=0.5')
      outputOptions.push('-map 1:a:0')
      // outputOptions.push('-c:a aac')
    }

    ffmpegProcess = ffmpegProcess
                      .format('segment')
                      .videoCodec('copy')
                      .outputOptions(outputOptions)
                      .on('start', function (commandLine) {
                        logger.info({
                          input: inputFile,
                          output: outputFile,
                          commandLine: commandLine
                        }, 'ffmpeg started.')
                      })
                      .on('progress', function (progress) {
                        if (lastFrame === progress.frames) {
                          potentialStallCount++
                          logger.warn('potential ffmpeg stall detected', progress)
                        } else {
                          potentialStallCount = 0
                        }

                        if (potentialStallCount >= 10) {
                          logger.error('terminating ffmpeg due to continued frame stall')
                          if (ffmpegProcess) {
                            ignoreNextError = true
                            ffmpegProcess.kill()
                            ffmpegProcess = null
                          }

                          setTimeout(function () {
                            startEncoder()
                          }, 1000)
                        }

                        lastFrame = progress.frames
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
                          ffmpegProcess.kill()
                          ffmpegProcess = null
                          setTimeout(function () {
                            startEncoder()
                          }, 20000)
                        }
                      })
                      .on('end', function () {
                        logger.info({
                          input: inputFile,
                          output: outputFile
                        }, 'ffmpeg ended.')

                        // attempt to restart ffmpeg if applicable
                        if (deviceState.encoderEnabled) {
                          ffmpegProcess.kill()
                          ffmpegProcess = null
                          setTimeout(function () {
                            startEncoder()
                          }, 20000)
                        }
                      })
                      .on('stderr', function (stderrLine) {
                        if (localConfig.verboseFfmpeg) {
                          console.error(stderrLine)
                        }
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
    snapshotInterval = setInterval(takeSnapshot, SNAPSHOT_INTERVAL)
  }

  function stopSnapshot () {
    if (!snapshotInterval) return
    logger.info('Stopping snapshot interval')
    clearInterval(snapshotInterval)
    snapshotInterval = null
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
  function checkForScheduledRecording () {
    const scheduled = deviceState.scheduledRecordings
    let isActive = false
    if (_.isEmpty(scheduled) || !_.isArrayLikeObject(scheduled)) {
      isActive = false
    } else {
      const now = moment()
      let entriesToRemove = []
      _.each(scheduled, function (si) {
        if (si == null || !si.startDate || !si.endDate) return

        var startMoment = moment(si.startDate)
        var endMoment = moment(si.endDate)

        if (!startMoment.isValid() || !endMoment.isValid()) return

        // start a little early and end a little late
        startMoment = startMoment.subtract(30, 'seconds')
        endMoment = endMoment.add(30, 'seconds')

        if (now.isBetween(startMoment, endMoment)) {
          isActive = true
        }

        if (now.diff(endMoment, 'days') >= 1) {
          entriesToRemove.push(si)
        }
      })

      if (entriesToRemove.length > 0) {
        let newEntries = _.difference(scheduled, entriesToRemove)
        process.send({
          type: 'RequestDeviceStateChange',
          payload: {
            scheduledRecordings: newEntries
          }
        })
      }
    }

    scheduledRecordingActive = isActive
    startOrStopEncoderAsNecessary()
  }
  function startScheduledRecordingsInterval () {
    if (scheduledRecordingsInterval) return
    scheduledRecordingsInterval = setInterval(checkForScheduledRecording, SCHEDULE_CHECK_INTERVAL)
  }
  function stopScheduledRecordingsInterval () {
    if (scheduledRecordingsInterval) {
      clearInterval(scheduledRecordingsInterval)
    }
    scheduledRecordingActive = false
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

  function startOrStopEncoderAsNecessary () {
    // if it should be running, and it isn't current running - start it
    if ((deviceState.encoderEnabled || scheduledRecordingActive) && !ffmpegProcess) {
      console.log('Starting Encoder')
      startEncoder()
    // if it should be off - but it is currently running - stop it
    } else if ((!deviceState.encoderEnabled && !scheduledRecordingActive) && !!ffmpegProcess) {
      console.log('Stopping Encoder')
      stopEncoder()
    }
  }

  function ProcessUpdatedDeviceState (state) {
    deviceState = state

    startOrStopEncoderAsNecessary()

    if (deviceState.snapshotEnabled && !snapshotInterval) {
      startSnapshot()
    } else if (!deviceState.snapshotEnabled && snapshotInterval) {
      stopSnapshot()
    }

    if (!_.isEmpty(deviceState.scheduledRecordings) && !scheduledRecordingsInterval) {
      startScheduledRecordingsInterval()
    } else if (_.isEmpty(deviceState.scheduledRecordings) && scheduledRecordingsInterval) {
      stopScheduledRecordingsInterval()
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


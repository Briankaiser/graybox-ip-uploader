const ffmpeg = require('fluent-ffmpeg');
const bunyan = require('bunyan');
const path = require('path');
const os = require('os');
const mkdirp = require('mkdirp');
const _ = require('lodash');

(function() {
  let localConfig = {};
  let deviceState = {};
  let ffmpegProcess;
  let logger;

  function getInput(config, state) {
    if(!_.isEmpty(config.inputSourceOverride)) {
      return config.inputSourceOverride;
    } else {
      return state.rtmpStreamAddress;
    }
  }

  function startEncoder(){
    //start ffmpeg
    const outputFile = path.join(localConfig.tmpDirectory, '/video/', 'output%Y-%m-%d_%H-%M-%S.mp4');
    const inputFile = getInput(localConfig, deviceState);
    ffmpegProcess = ffmpeg(inputFile)
                          .format('segment')
                          .outputOptions([
                            '-segment_time 4',
                            '-reset_timestamps 1',
                            '-strftime 1',
                            '-segment_start_number 1',
                            '-segment_format mp4',
                            '-c copy'
                          ])
                          //.output()
                          .on('start', function() {
                            logger.info({
                              input: inputFile,
                              output: outputFile,
                            },'ffmpeg started.')
                          })
                          .on('error', function(err) {
                            logger.info({
                              input: inputFile,
                              output: outputFile,
                              error: err,
                            },'ffmpeg error')
                          })
                          .on('end', function() {
                            logger.info({
                              input: inputFile,
                              output: outputFile,
                            },'ffmpeg ended.')
                          })
                          .save(outputFile);
  }
  function stopEncoder() {
    if(!!ffmpegProcess) {
      ffmpegProcess.kill();
      ffmpegProcess = null;
    }
  }

  function init(config) {
    localConfig = config;
    logger = bunyan.createLogger({
      name: 'encoder-log',
      deviceId: localConfig.deviceId,
      streams: [{
          type: 'rotating-file',
          path: path.join(config.loggingPath, 'encoder-log.log'),
          period: '1d',   // daily rotation
          count: 3        // keep 3 back copies
      },
      {
        stream: process.stderr,
        level: "debug"
      }]
    });
    mkdirp(path.join(localConfig.tmpDirectory, '/video/'));

  }

  function ProcessUpdatedDeviceState(state) {
    deviceState = state;
    if(deviceState.encoderEnabled && !ffmpegProcess) {
      startEncoder();
    }else if(!deviceState.encoderEnabled && !!ffmpegProcess) {
      stopEncoder();
    }
  }
  function buildEncoderStatusMessage() {
    return {
      type: 'StatusUpdate',
      payload: {
        ffmpegRunning: !!ffmpegProcess,  
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
    process.send(buildEncoderStatusMessage());
  }, 10000);



})();


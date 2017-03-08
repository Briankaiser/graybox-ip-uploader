const bunyan = require('bunyan')
const path = require('path')
const fs = require('fs')
const deferred = require('deferred')
const S3 = require('aws-sdk/clients/s3')
const _ = require('lodash')

const promisify = deferred.promisify
const readDirAsync = promisify(fs.readdir)
const unlinkAsync = promisify(fs.unlink)

const VALID_EXT = ['.mp4', '.ts', '.jpg']

;(function () {
  let localConfig = {}
  let deviceState = {}
  let logger
  let s3Service
  let uploaderInterval
  let currentlyUploading = false
  let lastCountPendingVideoFiles, oldestFileName, newestFileName
  let lastUploadDurationSec, lastUploadSpeedMBps
  let lastSnapshotUrl
  let videoPath

  function checkAndUploadNextFile () {
    if (currentlyUploading) return

    try {
      currentlyUploading = true

      // TODO: do we need some way to track files that fail multiple times and mark as bad
      // and skip or delete?

      // TODO: should we use watch() and just add existing files to a queue?
      // basically populate a queue on startup - then use watch to add items?

      readDirAsync(videoPath).then(function (files) {
        if (_.isEmpty(files)) return
        const curDate = new Date()
        var toUploadList = _.chain(files)
            .map(function (f) {
              let fp = path.join(videoPath, f)
              return {filename: fp, stat: fs.statSync(fp)}
            })
            .filter((s) => {
              return s.stat && s.stat.isFile() && _.some(VALID_EXT, (e) => e === path.extname(s.filename)) &&
                s.stat.mtime.getTime() < curDate.getTime() - 1500 // make sure time hasn't been modified for 1s
            })
            .sortBy('stat.mtime')
            .value()

        lastCountPendingVideoFiles = toUploadList.length
        const toUpload = _.head(toUploadList)
        oldestFileName = toUpload && toUpload.filename && path.basename(toUpload.filename)
        const newestItem = _.last(toUploadList)
        newestFileName = newestItem && newestItem.filename && path.basename(newestItem.filename)
        return toUpload && toUpload.filename
      }).then(function (toUpload) {
        if (!toUpload) return

        logger.debug(toUpload, 'Starting upload')
        const fileKey = path.join(localConfig.deviceId, path.basename(toUpload))

        const acl = path.extname(toUpload) === '.jpg' ? 'public-read' : 'private'
        const uploadFs = fs.createReadStream(toUpload)
        // upload then delete
        // build the promise chain here so we have the file name, report status
        const uploadStartTime = new Date().getTime()
        return s3Service.upload({
          Bucket: deviceState.uploadBucket,
          Key: fileKey,
          ACL: acl,
          Body: uploadFs
        }).promise()
          .then(() => {
            lastUploadDurationSec = (new Date().getTime() - uploadStartTime) / 1000.0
            lastUploadSpeedMBps = ((uploadFs.bytesRead / 1024 / 1024) / lastUploadDurationSec).toFixed(2)
            return unlinkAsync(toUpload)
          }) // delete file on successful upload
          .then(() => {
            logger.debug(toUpload, 'successfully uploaded and deleted with MBps: ', lastUploadDurationSec)
            if (path.extname(toUpload) === '.jpg') {
              lastSnapshotUrl = 'http://' + deviceState.uploadBucket + '.s3.amazonaws.com/' + fileKey
            }
          })
      })
      .done(function () {
        currentlyUploading = false
      }, function (err) {
        if (err.code === 'EBUSY') {
          logger.debug(err, 'file is still busy. will retry')
        } else if (err.code === 'UnknownEndpoint') {
          logger.debug({code: err.code, message: err.message}, 'Cant connect to endpoint. Probably no internet')
        } else if (err.name === 'RequestTimeTooSkewed') {
          logger.info('Couldnt correct clock skew. Recreating uploader.')
          setImmediate(initUploader)
        } else {
          logger.warn(err)
        }
        currentlyUploading = false
      })
      // find all available files to upload
      // upload the oldest one
      // log
      // on success - delete it
    } catch (error) {
      currentlyUploading = false
    } finally {
    }
  }

  function initUploader () {
    logger.info('Initializing uploader')
    // TODO: verify data. we need awsRegion, uploadBucket, accessKey, secretKey
    s3Service = new S3({
      region: deviceState.awsRegion,
      accessKeyId: deviceState.accessKey,
      secretAccessKey: deviceState.secretKey,
      computeChecksums: true,
      correctClockSkew: true,
      logger: logger
    })

    if (uploaderInterval) {
      clearInterval(uploaderInterval)
    }
    uploaderInterval = setInterval(checkAndUploadNextFile, 2000)
  }

  function init (config) {
    localConfig = config
    logger = bunyan.createLogger({
      name: 'uploader-log',
      deviceId: localConfig.deviceId,
      streams: [{
        type: 'rotating-file',
        level: 'info',
        path: path.join(config.loggingPath, 'uploader-log.log'),
        period: '1d',   // daily rotation
        count: 3        // keep 3 back copies
      },
      {
        stream: process.stdout,
        level: 'debug'
      }]
    })
    videoPath = path.join(localConfig.tmpDirectory, '/video/')

    // now wait for deviceState so we can construct the uploader
  }

  function ProcessUpdatedDeviceState (newState) {
    let prevState = deviceState
    deviceState = newState

    // init uploader if important deviceState properties change
    // this also handles initial init
    if ((prevState.accessKey !== newState.accessKey) ||
       (prevState.secretKey !== newState.secretKey) ||
       (prevState.awsRegion !== newState.awsRegion) ||
       (prevState.uploadBucket !== newState.uploadBucket)) {
      initUploader()
    }
  }

  function buildUploaderStatusMessage () {
    return {
      type: 'StatusUpdate',
      payload: {
        filesPendingUpload: lastCountPendingVideoFiles,
        isUploaderRunning: !!uploaderInterval,
        oldestFileName: oldestFileName,
        newestFileName: newestFileName,
        lastSnapshotUrl: lastSnapshotUrl,
        lastUploadDurationSec: lastUploadDurationSec,
        lastUploadSpeedMBps: lastUploadSpeedMBps
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
    process.send(buildUploaderStatusMessage())
  }, 10000)
})()

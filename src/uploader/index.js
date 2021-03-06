const bunyan = require('bunyan')
const path = require('path')
const fs = require('fs')
const deferred = require('deferred')
const S3 = require('aws-sdk/clients/s3')
const _ = require('lodash')
var https = require('https')
// const memwatch = require('memwatch-next')
// const heapdump = require('heapdump')

const promisify = deferred.promisify
const readDirAsync = promisify(fs.readdir)
const unlinkAsync = promisify(fs.unlink)

const VALID_EXT = ['.mp4', '.ts', '.mkv', '.jpg']
// const RE_INIT_UPLOAD_MAX = 100
const RESTART_PROCESS_MAX = 2000

;(function () {
  let localConfig = {}
  let deviceState = {}
  let logger
  let s3Service
  let uploaderInterval
  let currentlyUploading = false
  let lastCountPendingVideoFiles, oldestFileName, newestFileName
  let lastUploadDurationSec, lastUploadSpeedMBps
  let lastSnapshotUrl, lastVideoFragmentUrl
  let videoPath
  let httpsAgent
  let uploadCountSinceReInit

  function checkAndUploadNextFile () {
    if (currentlyUploading) return

    let uploadFs
    try {
      currentlyUploading = true

      // TODO: do we need some way to track files that fail multiple times and mark as bad
      // and skip or delete?

      readDirAsync(videoPath).then(function (files) {
        if (_.isEmpty(files)) return
        const curDate = new Date()
        const toUploadList = _.chain(files)
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
        // reverse device id for better S3 path diversity
        const reverseDeviceId = localConfig.deviceId.split('').reverse().join('')
        const fileKey = reverseDeviceId + '/' + path.basename(toUpload)

        const acl = (path.extname(toUpload) === '.jpg') || deviceState.publicVideoEnabled ? 'public-read' : 'private'
        // const fileSize = fs.statSync(toUpload).size
        uploadFs = fs.createReadStream(toUpload)
        // upload then delete
        // build the promise chain here so we have the file name, report status

        // this doesn't seem to matter. keeping it in here in case I need it again
        // if (uploadCountSinceReInit++ > RE_INIT_UPLOAD_MAX) {
        //   initS3Service()
        // }

        // I hate this but i can't find the mem leak. so we will just restart the process
        // every once in a while
        if (uploadCountSinceReInit++ > RESTART_PROCESS_MAX) {
          logger.info('restarting uploader to relieve mem pressure')
          process.exit(0)
          return
        }

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
            // record the jpg path for an uploaded image
            if (path.extname(toUpload) === '.jpg') {
              lastSnapshotUrl = 'http://' + deviceState.uploadBucket + '.s3.amazonaws.com/' + fileKey
            } else if (!deviceState.snapshotEnabled) { // if snapshot off - clear it to save transfer
              lastSnapshotUrl = ''
            }

            lastVideoFragmentUrl = deviceState.publicVideoEnabled
              ? 'http://' + deviceState.uploadBucket + '.s3.amazonaws.com/' + fileKey : ''
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

    initS3Service()

    if (uploaderInterval) {
      clearInterval(uploaderInterval)
    }
    uploaderInterval = setInterval(checkAndUploadNextFile, 2000)
  }
  function initS3Service () {
    logger.info('init s3 service')
    uploadCountSinceReInit = 0
    
    if (httpsAgent) {
      httpsAgent.destroy()
      httpsAgent = null
    }

    httpsAgent = new https.Agent({
      rejectUnauthorized: true,
      maxSockets: 20,
      keepAlive: true,
      maxFreeSockets: 20
    })
    s3Service = new S3({
      region: deviceState.awsRegion,
      accessKeyId: deviceState.accessKey,
      secretAccessKey: deviceState.secretKey,
      // computeChecksums: true,
      correctClockSkew: true,
      // logger: logger,
      httpOptions: {
        timeout: 5000,
        agent: httpsAgent
      }
    })
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
        level: 'info'
      }]
    })
    videoPath = path.join(localConfig.tmpDirectory, '/video/')

    // memwatch.setup()
    // memwatch.on('leak', function (info) {
    //   console.error('leak info', info)
    //   heapdump.writeSnapshot(function (err, filename) {
    //     console.log('dumped heap', filename)
    //   })
    //   if (!hd) {
    //     hd = new memwatch.HeapDiff()
    //   } else {
    //     var diff = hd.end()
    //     console.error('heap diff', diff)
    //     hd = null
    //   }
    // })
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
        lastVideoFragmentUrl: lastVideoFragmentUrl,
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

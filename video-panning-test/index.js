const ffmpeg = require('fluent-ffmpeg')
const path = require('path')
const promisify = require('promisify-node')
const sharp = require('sharp')
const readline = require('readline')
const fs = promisify('fs')

const movieFile = process.argv[2] 
const tmpDirectory = path.dirname(movieFile)
const imagesDirectory = path.join(tmpDirectory, 'images')
const imageExtension = '.jpg'
const imageFileNames = '%05d' + imageExtension
const imagesOutput = path.join(imagesDirectory, imageFileNames)

const croppedDirectory = path.join(tmpDirectory, 'cropped')

const courtPanTime = 30*8 // # of frames to pan edge to edge (speed)

const mkdirSync = function (dirPath) {
  try {
    fs.mkdirSync(dirPath)
  } catch (err) {
    if (err.code !== 'EEXIST') throw err
  }
}


async function generateImages () {
  mkdirSync(tmpDirectory)
  mkdirSync(imagesDirectory)
  console.log('Generating images from input...')
  console.log('frame: 0')
  const p = new Promise((resolve, reject) => {
    ffmpeg()
      .addInput(movieFile)
      .format('image2')
      .withOutputFps(30)
      .withOutputOptions([
        '-q:v 2'
      ])
      .on('start', function(commandLine) {
        // console.log('Spawned Ffmpeg with command: ' + commandLine);
      })
      .on('end', function () {
        resolve()
      })
      .on('progress', function (progress) {
        readline.moveCursor(process.stdout, 0,-1)
        console.log('frame: ' + progress.frames)
      })
      .on('error', function () {
        reject()
      })
      .save(imagesOutput)
  })

  return p
}

async function generateCrops () {
  const cropHeight = 800 // height necessary to include the whole court
  const cropWidth = parseInt((16/9)*cropHeight) // aspect ratio width
  const topOffset = 500 // try to isolate the court
  const finalVideoWidth = 1280
  const finalVideoHeight = 720

  console.log('Generating crops...')
  let curImage = 0
  console.log('frame: ' + curImage)
  mkdirSync(croppedDirectory)

  const files = await fs.readdir(imagesDirectory)
  const startP = Promise.resolve()
  const finalPromise = files
    .filter(f=>path.extname(f) === imageExtension)
    .reduce((p, f) => {
      return p.then(function() {
        readline.moveCursor(process.stdout, 0,-1)
        console.log('frame: ' + ++curImage)

        const image = sharp(path.join(imagesDirectory, f))
        return image 
          .metadata()
          .then(function (metadata) {
            // make the left value pan back and forth
            const maxLeft = metadata.width - cropWidth
            const curLeft = parseInt(Math.cos(curImage*2*Math.PI/courtPanTime)*(maxLeft/2) + (maxLeft/2));
            return image.extract({
              left: curLeft,
              top: topOffset,
              width: cropWidth,
              height: cropHeight
            })
            .resize(finalVideoWidth, finalVideoHeight)
            .jpeg({
              quality: 98
            })
            .toFile(path.join(croppedDirectory, f))
          })

    })
  }, startP)
  return finalPromise
}

async function generateFinalVideo () {
    console.log('Generating final movie...')
    console.log('frame: 0')
    const inputImages = path.join(croppedDirectory, imageFileNames)
    const outputFile = path.join(tmpDirectory, 'output.mp4')
    const p = new Promise((resolve, reject) => {
      ffmpeg()
        .addInput(inputImages)
        .inputFormat('image2')
        .videoCodec('libx264')
        .outputFps(30)
        .outputOptions([
          '-pix_fmt yuv420p',
          '-crf 16',
          '-profile:v high'
        ])
        .on('start', function(commandLine) {
          // console.log('Spawned Ffmpeg with command: ' + commandLine);
        })
        .on('end', function () {
          resolve()
        })
        .on('progress', function (progress) {
          readline.moveCursor(process.stdout, 0,-1)
          console.log('frame: ' + progress.frames )
        })
        .on('error', function (err, stdout, stderr) {
          console.log(err,stdout, stderr)
          reject()
        })
        .save(outputFile)
  })

  return p
}

generateImages()
  .then(generateCrops)
  .then(generateFinalVideo)
  .then(function () {
    console.log('COMPLETE')
  })


// run sharp to 'extract' the right size on each frame into another temp directory

// using ffmpeg join the images back together into a movie
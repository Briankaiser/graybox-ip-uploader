const ffmpeg = require('fluent-ffmpeg')
const path = require('path')
const promisify = require('promisify-node')
const sharp = require('sharp')
const fs = promisify('fs')

// extract all the frames into a temp directory
const movieFile = 'J:\\graybox-videos\\004L-01\\output2017-03-27_14-47-49.ts'
const tmpDirectory = 'J:\\tmp\\pan-test\\'
const imagesDirectory = path.join(tmpDirectory, 'images')
const imagesOutput = path.join(imagesDirectory, '%05d.bmp')

const croppedDirecotry = path.join(tmpDirectory, 'cropped')


async function generateImages () {
  const p = new Promise((resolve, reject) => {
    ffmpeg()
      .addInput(movieFile)
      .format('image2')
      .withOutputFps(30)
      .on('end', function () {
        resolve()
      })
      .on('progress', function (progress) {
        // progress.frames, progress.percent
      })
      .on('error', function () {
        reject()
      })
      .save(imagesOutput)
  })

  await p
}

async function generateCrops () {
  var files = await fs.readdir(imagesDirectory)

  const outPromises = files.map((f) => {
    const outFileName = path.join(croppedDirecotry, f)
    return sharp(path.join(imagesDirectory, f).extract({
      left: 0,
      top: 0,
      width: 1280,
      height: 720
    }).toFile(outFileName)
  })
  await Promise.all(outPromises)
}
//generateImages()
generateCrops()

// run sharp to 'extract' the right size on each frame into another temp directory

// using ffmpeg join the images back together into a movie
const yaml = require('js-yaml')
const deferred = require('deferred')
const os = require('os')
const fs = require('fs')
const path = require('path')
const mkdirp = require('mkdirp')
const _ = require('lodash')
const promisify = deferred.promisify

const readFileAsync = promisify(fs.readFile)
const mkdirpAsync = promisify(mkdirp)

const argv = require('yargs').default('config', '../config/local-config.yaml').argv
const defaultConfig = {
  'deviceId': '',
  'ffmpegOverridePath': '',
  'tmpDirectory': path.join(os.homedir(), '/graybox'),
  'loggingPath': path.join(os.homedir(), '/graybox/logs'),
}

module.exports =
{
  load: function () {
    const d = deferred()
    const configLocation = argv.config

    readFileAsync(configLocation, 'utf8')
      .then(function (result) {
        const tmpConfig = _.merge(defaultConfig, _.omitBy(yaml.safeLoad(result), _.isEmpty))
        return mkdirpAsync(tmpConfig.tmpDirectory).then(() => mkdirpAsync(tmpConfig.loggingPath)).then(() => tmpConfig)
      }).done(function (config) {
        d.resolve(config)
      }, function (err) {
        d.reject(err)
      })
    return d.promise
  }
}

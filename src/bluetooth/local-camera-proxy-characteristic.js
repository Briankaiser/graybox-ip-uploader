var util = require('util')
var bleno = require('bleno')
var Descriptor = bleno.Descriptor
var Characteristic = bleno.Characteristic

var LocalCameraProxyCharacteristic = function (initialStatusObject, stateChangedEmitter) {
  LocalCameraProxyCharacteristic.super_.call(this, {
    uuid: '2A89',
    properties: ['read', 'write', 'writeWithoutResponse'],
    descriptors: [
      new Descriptor({
        uuid: '2901',
        value: 'Gets/sets boolean if local camera proxy is activated'
      })
    ]
  })
  this.status = initialStatusObject
  this._value = new Buffer(0)
  this._updateValueCallback = null
  stateChangedEmitter.on('statusChanged', (newStatus) => { this.status = newStatus })
}

util.inherits(LocalCameraProxyCharacteristic, Characteristic)

LocalCameraProxyCharacteristic.prototype.onReadRequest = function (offset, callback) {
  if (!offset) {
    const tmpValue = this.status && this.status.localCameraProxy ? this.status.localCameraProxy.toString() : 'false'
    this._value = new Buffer(tmpValue)
  }
  callback(this.RESULT_SUCCESS, this._value.slice(offset, this._value.length))
}

LocalCameraProxyCharacteristic.prototype.onWriteRequest = function (data, offset, withoutResponse, callback) {
  if (offset) {
    callback(this.RESULT_ATTR_NOT_LONG)
  } else if (data.length !== 1) {
    callback(this.RESULT_INVALID_ATTRIBUTE_LENGTH)
  } else {
    var shouldActivateString = data.toString('utf8')
    if (shouldActivateString === 'true' || shouldActivateString === 'false') {
      // set and propagate value
      this._value = Buffer.from(data)
      process.send({
        type: 'RequestDeviceStateChange',
        payload: {
          localCameraProxy: (shouldActivateString === 'true')
        }
      })

      callback(this.RESULT_SUCCESS)
    } else {
      callback(this.RESULT_UNLIKELY_ERROR)
    }
  }
}

module.exports = LocalCameraProxyCharacteristic

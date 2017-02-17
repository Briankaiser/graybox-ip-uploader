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
    const tmpValue = this.status && this.status.localCameraProxy ? 1 : 0
    this._value = new Buffer(1)
    this._value.writeUInt8(tmpValue, 0)
  }
  callback(this.RESULT_SUCCESS, this._value.slice(offset, this._value.length))
}

LocalCameraProxyCharacteristic.prototype.onWriteRequest = function (data, offset, withoutResponse, callback) {
  if (offset) {
    callback(this.RESULT_ATTR_NOT_LONG)
  } else if (data.length !== 1) {
    callback(this.RESULT_INVALID_ATTRIBUTE_LENGTH)
  } else {
    var shouldActivate = data.readUInt8(0)
    if (shouldActivate === 0 || shouldActivate === 1) {
      // set and propagate value
      this._value = new Buffer(1)
      this._value.writeUInt8(shouldActivate, 0)
      process.send({
        type: 'RequestDeviceStateChange',
        msg: {
          localCameraProxy: !!shouldActivate
        }
      })

      callback(this.RESULT_SUCCESS)
    } else {
      callback(this.RESULT_UNLIKELY_ERROR)
    }
  }
}

module.exports = LocalCameraProxyCharacteristic

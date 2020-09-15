const { Duplex } = require('stream')
const { readFileSync } = require('fs')
const path = require('path')
const mutexify = require('mutexify/promise')
const csvParse = require('csv-parse/lib/sync')

const readCodes = function (filename) {
  const content = readFileSync(path.join(__dirname, 'codes', filename))
  return csvParse(content, { columns: true })
}

const ERROR_CODES = readCodes('error_codes.csv')
const SETTING_CODES = readCodes('setting_codes.csv')
const DELIMETER = Buffer.from('\r\n')

const parseMessage = function (input, prefix) {
  prefix = `[${prefix}:`

  if (!input || !input.startsWith(prefix) || !input.endsWith(']')) {
    throw new ProtocolError(`Expected input format ${prefix}]`, input)
  }

  return input.slice(prefix.length, -1)
}

const formatCoordinate = function (axis, coord) {
  if (coord != null) return axis + coord.toFixed(1)
}

class GrblError extends Error {}

class ProtocolError extends GrblError {
  constructor (message, input) {
    super(message)
    this.input = input
  }
}

class CommandError extends GrblError {
  static fromCode (code) {
    const row = ERROR_CODES.find(error => error['Error Code'] === code) || {}
    return new CommandError(code, row['Error Message'], row['Error Description'])
  }

  constructor (code, message, description) {
    super(`[${message}] ${description} (code: ${code})`)

    this.errorCode = code
    this.errorMessage = message
    this.errorDescription = description
  }
}

class GrblStream extends Duplex {
  constructor () {
    super()

    const lock = mutexify()
    const future = lock()

    const onversion = data => {
      // Grbl 1.1f ['$' for help]
      const match = data.match(/^Grbl (\d+\.\d+[a-zA-Z]) \['\$' for help\]$/)
      if (!match) this.destroy(new ProtocolError('Expected version format Grbl <version> [\'$\' for help]', data))
      this.emit('version', match[1])
      this._parse = onheader
    }

    const onheader = data => {
      // [MSG:'$H'|'$X' to unlock]
      future
        .then(release => {
          onmessage(data)
          this._parse = onmessage
          release()
        })
        .catch(err => this.destroy(err))
    }

    const onmessage = data => {
      this.emit('message', data)
    }

    this._lock = lock
    this._parse = onversion
    this._buffer = Buffer.alloc(0)
  }

  async help () {
    // [HLP:$$ $# $G $I $N $x=val $Nx=line $J=line $SLP $C $X $H ~ ! ? ctrl-x]
    const help = await this.command('$')
    return parseMessage(help.pop(), 'HLP')
  }

  async settings () {
    // $0=10
    const settings = await this.command('$$')

    return settings.map(line => {
      const pair = line.match(/^\$([^=]+)=([^ ]*)/)

      if (pair) {
        const code = pair[1]
        const row = SETTING_CODES.find(setting => setting.Code === code) || {}

        return {
          code: code,
          setting: row.Setting,
          units: row.Units,
          description: row['Setting Description'],
          value: pair[2]
        }
      } else {
        throw new ProtocolError('Expected settings format $x=val', line)
      }
    })
  }

  async status () {
    // <Alarm|MPos:0.000,0.000,0.000|Bf:14,127|FS:0,0|WCO:0.000,0.000,0.000>
    const status = (await this.command('?')).pop()

    if (!status || !status.startsWith('<') || !status.endsWith('>')) {
      throw new ProtocolError('Expected status format', status)
    }

    const segments = status.slice(1, -1).split('|')
    const result = { state: segments[0] }

    segments.forEach(segment => {
      const [type, a, b, c] = segment.split(/:|,/)

      switch (type) {
        case 'MPos':
          result.machinePosition = {
            x: parseFloat(a),
            y: parseFloat(b),
            z: parseFloat(c)
          }

          break
        case 'WCO':
          result.workCoordinateOffset = {
            x: parseFloat(a),
            y: parseFloat(b),
            z: parseFloat(c)
          }

          break
        case 'Bf':
          result.buffer = {
            plannerBlocks: parseInt(a, 10),
            rxBytes: parseInt(b, 10)
          }

          break
        case 'FS':
          result.feedAndSpeed = {
            feedRate: parseInt(a, 10),
            spindle: parseInt(b, 10)
          }

          break
        case 'Pn':
          result.pinState = a
          break
        case 'Ov':
          result.overrideValues = {
            feed: parseInt(a, 10),
            rapids: parseInt(b, 10),
            spindle: parseInt(c, 10)
          }

          break
      }
    })

    return result
  }

  async runHomingCycle () {
    await this.command('$H')
  }

  async killAlarmLock () {
    await this.command('$X')
  }

  async rapidTravel () {
    await this.command('G00')
  }

  async imperialCoordinates () {
    await this.command('G20')
  }

  async metricCoordinates () {
    await this.command('G21')
  }

  async absolutePositioning () {
    await this.command('G90')
  }

  async incrementalPositioning () {
    await this.command('G91')
  }

  async position (xOrPoint, y, z) {
    let x = xOrPoint

    if (typeof xOrPoint === 'object') {
      x = xOrPoint.x
      y = xOrPoint.y
      z = xOrPoint.z
    }

    const coordinates = [
      formatCoordinate('X', x),
      formatCoordinate('Y', y),
      formatCoordinate('Z', z)
    ].filter(Boolean)

    await this.command(coordinates.join(' '))
  }

  async command (cmd) {
    const release = await this._lock()

    try {
      this.push(cmd + '\n')
      this.emit('command', cmd)
      return await this._ok()
    } finally {
      release()
    }
  }

  _read (size) {}

  _write (data, encoding, cb) {
    let buffer = Buffer.concat([this._buffer, data])
    let position = 0

    while ((position = buffer.indexOf(DELIMETER)) !== -1) {
      const line = buffer.slice(0, position)
      if (line.length) this._parse(line.toString('utf8'))
      buffer = buffer.slice(position + DELIMETER.length)
    }

    this._buffer = buffer
    cb()
  }

  _ok () {
    return new Promise((resolve, reject) => {
      const lines = []
      const onmessage = data => {
        if (data === 'ok') {
          resolve(lines)
          this.removeListener('message', onmessage)
        } else if (data.startsWith('error:')) {
          const code = data.slice(6)
          reject(CommandError.fromCode(code))
        } else {
          lines.push(data)
        }
      }

      this.on('message', onmessage)
    })
  }
}

exports.GrblError = GrblError
exports.ProtocolError = ProtocolError
exports.CommandError = CommandError
exports.GrblStream = GrblStream

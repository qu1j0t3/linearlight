import fetch from 'node-fetch';
import storage from 'node-persist';

const api = 'http://192.168.68.112';

const limitsKey = 'LIMITS';
const levelKey = 'LEVEL';

// Typical current measurement:
// 192,179,157,155
// DAC ref voltage 0.779 V (#1)
// according to DAC codes, the max current driven on a string is at ~ 0.586 V (code 192 at ref#1)
// so we can safely reduce the DAC reference to 0.611 V (code 200 at ref#1)
// To do this we need to reduce R5 from 1k to about 784.3 Ohm
// As a bodge it's easiest to fit a parallel resistor,
// so this would be about 1k || 7.15k || 7.5k (values I have in stock)
// With the 3 resistors fitted, the DAC reference is now 0.657 V
// and typical current limits:
// 228,214,185,184

function errorHandler(r) {
  if (r.ok) {
    //console.info(`Request OK: ${r.url}`);
    return r;
  } else {
    return Promise.reject(`${r.statusText}: ${r.url}`);
  }
}

async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function setLevel(level) {
  const body = `L${level}`;
  return fetch(`${api}/level`, {method: 'PUT', body})
    .then(errorHandler)
    .then(() => delay(5));
}

function setChannels(arr) {
  const body = `W${arr.join(',')}`;
  return fetch(`${api}/ctrl`, {method: 'PUT', body})
    .then(errorHandler)
    .then(() => delay(5));
}

const channelKey = ['pin17', 'pin16', 'pin5', 'pin19'];

function getLimitSignal(idx) {
  return fetch(`${api}/limit`)
    .then(errorHandler)
    .then(resp => resp.json())
    .then(j => j[channelKey[idx]] !== 0);
}

function channelValues(idx, value) {
  const arr = [0, 0, 0, 0];
  arr[idx] = value;
  return arr;
}

async function findLimit(idx, lo, hi) {
  const mid = Math.floor((lo+hi)/2);
  if (mid === lo) {
    return lo;
  } else {
    await setChannels(channelValues(idx, mid));
    const limit = await getLimitSignal(idx);
    return limit ? findLimit(idx, lo, mid) : findLimit(idx, mid, hi);
  }
}

async function getLimits() {
  return [
    await findLimit(0, 0, 255),
    await findLimit(1, 0, 255),
    await findLimit(2, 0, 255),
    await findLimit(3, 0, 255)
  ];
}

function median(a) {
  const mid = Math.floor(a.length/2);
  return a.sort()[mid];
}

async function calib(n, log) {
  const rs = [], gs = [], bs = [], ws = [];
  await setLevel(255);
  for(let i = 0; i < n; ++i) {
    const [r, g, b, w] = await getLimits();
    rs.push(r);
    gs.push(g);
    bs.push(b);
    ws.push(w);
    if(log) {
      console.log(`${r},${g},${b},${w}`);
    }
  }
  await setLevel(0);
  const limits = [median(rs), median(gs), median(bs), median(ws)];
  await storage.setItem(limitsKey, limits);
  return limits;
}

async function initLevels() {
  const level = await storage.getItem(levelKey);
  if (level) {
    console.log(`From storage: level ${level}`);
  }
  await setLevel(level || 255);
}

await storage.init({dir: 'settings/emilite'});

switch (process.argv[2]) {
  case 'long': // Long calibration. Run 100 times and print results.
    await calib(100, true);
    break;
  case 'calib':
    console.log(await calib(5, true));
    break;
  case 'colour':
    let lim = await storage.getItem(limitsKey);
    if (!lim) {
      lim = await calib(5, true);
    } else {
      console.log(`From storage: limits ${lim}`)
    }
    await initLevels();
    switch (process.argv.length) {
      case 4:
        const k = parseFloat(process.argv[3]);
        console.info(k)
        await setChannels(lim.map(x => Math.floor(k*x)));
        break;
      case 7:
        const r = parseFloat(process.argv[3]);
        const g = parseFloat(process.argv[4]);
        const b = parseFloat(process.argv[5]);
        const w = parseFloat(process.argv[6]);
        const [rl, gl, bl, wl] = lim;
        await setChannels([r*rl, g*gl, b*bl, w*wl].map(Math.floor));
        break;
    }
    break;
  case 'white':
    await initLevels();
    await setChannels([255, 255, 255, 255]);
    break;
  case 'off':
    await setChannels([0, 0, 0, 0]);
    break;
  default:
    console.info(`Supported commands:
      long            : run calibration 100 times and print limits
      calib           : run calibration 5 times and store channel limits in persistent 'settings' directory
      colour X        : where X is a floating point number between 0 and 1.0,
                        set all four channels to this fraction of their limit
      colour R G B W  : where R, G, B, W are floating point numbers between 0.0 and 1.0,
                        set respective channel to fraction of their limit
      white           : full brightness
      off             : minimum brightness
    `);
}

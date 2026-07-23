var config = require('./config');

var xhrRequest = function (url, type, callback) {
  var xhr = new XMLHttpRequest();
  xhr.onload = function () {
    callback(this.responseText);
  };
  xhr.open(type, url);
  xhr.send();
};

var xhrPostJson = function (url, headers, body, callback, errback) {
  var xhr = new XMLHttpRequest();
  xhr.onload = function () {
    if (this.status >= 200 && this.status < 300) callback(this.responseText);
    else errback('HTTP ' + this.status);
  };
  xhr.onerror = function () { errback('network error'); };
  xhr.open('POST', url);
  for (var k in headers) { if (headers.hasOwnProperty(k)) xhr.setRequestHeader(k, headers[k]); }
  xhr.send(JSON.stringify(body));
};

var currentSteps = [];
var currentStepIndex = 0;
var watchId = null;

var ADVANCE_RADIUS_M = 8;
var MAX_FIX_ACCURACY_M = 25;

function haversineMeters(lat1, lon1, lat2, lon2) {
  var R = 6371000;
  var dLat = (lat2 - lat1) * Math.PI / 180;
  var dLon = (lon2 - lon1) * Math.PI / 180;
  var a = Math.sin(dLat/2) * Math.sin(dLat/2) +
          Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
          Math.sin(dLon/2) * Math.sin(dLon/2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function stopWatching() {
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
    console.log('GPS watch cleared.');
  }
}

function startWatching(retryCount) {
  retryCount = retryCount || 0;
  stopWatching();
  watchId = navigator.geolocation.watchPosition(
    function(pos) {
      if (currentSteps.length === 0) return;
      if (pos.coords.accuracy && pos.coords.accuracy > MAX_FIX_ACCURACY_M) {
        console.log('GPS fix too coarse: ' + pos.coords.accuracy.toFixed(0) + 'm, skipping');
        return;
      }
      var nextIndex = currentStepIndex + 1;
      if (nextIndex >= currentSteps.length) return;
      var waypoint = currentSteps[nextIndex].maneuver.location;
      var dist = haversineMeters(pos.coords.latitude, pos.coords.longitude, waypoint[1], waypoint[0]);
      console.log('GPS tick: ' + dist.toFixed(1) + 'm to step ' + nextIndex + ' (acc ' + (pos.coords.accuracy || -1).toFixed(0) + 'm)');
      try {
        var gl = JSON.parse(localStorage.getItem('gpsLog') || '[]');
        gl.push(new Date().toISOString().substr(11,8) + ' s' + nextIndex + ' d' + dist.toFixed(1) + ' a' + (pos.coords.accuracy || -1).toFixed(0));
        if (gl.length > 300) gl = gl.slice(-300);
        localStorage.setItem('gpsLog', JSON.stringify(gl));
      } catch (e) {}
      if (localStorage.getItem('autoAdvance') !== 'off' && dist < ADVANCE_RADIUS_M) {
        currentStepIndex = nextIndex;
        sendStep(currentStepIndex);
        if (currentStepIndex === currentSteps.length - 1) {
          console.log('Arrived at destination, clearing GPS watch.');
          stopWatching();
        }
      }
    },
    function(err) {
      console.log('watchPosition error: ' + err.code + ' (attempt ' + (retryCount + 1) + ')');
      if (retryCount < 3) {
        setTimeout(function() { startWatching(retryCount + 1); }, 2000);
      } else {
        console.log('GPS watch failed after 3 retries, giving up.');
      }
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 }
  );
  console.log('GPS watch started (attempt ' + (retryCount + 1) + ')');
}

function maneuverToInt(type, modifier) {
  var m = modifier || '';
  if (type === 'arrive') return 9;
  if (type === 'depart' || type === 'continue') {
    if (m === 'slight right') return 2;
    if (m === 'right') return 3;
    if (m === 'sharp right') return 4;
    if (m === 'uturn') return 5;
    if (m === 'sharp left') return 6;
    if (m === 'left') return 7;
    if (m === 'slight left') return 8;
    return 1; // straight / default
  }
  if (type === 'turn' || type === 'on ramp' || type === 'off ramp' || type === 'fork') {
    if (m === 'slight right') return 2;
    if (m === 'right') return 3;
    if (m === 'sharp right') return 4;
    if (m === 'uturn') return 5;
    if (m === 'sharp left') return 6;
    if (m === 'left') return 7;
    if (m === 'slight left') return 8;
    return 1;
  }
  if (type === 'roundabout' || type === 'rotary' || type === 'roundabout turn') {
    if (m === 'left' || m === 'sharp left' || m === 'slight left') return 11;
    return 10; // right by default
  }
  return 0; // depart/unknown — straight arrow
}

var GOOGLE_MANEUVER_INT = {
  'DEPART': 0, 'STRAIGHT': 1, 'NAME_CHANGE': 1, 'MERGE': 1,
  'TURN_SLIGHT_RIGHT': 2, 'FORK_RIGHT': 2, 'RAMP_RIGHT': 2,
  'TURN_RIGHT': 3, 'TURN_SHARP_RIGHT': 4,
  'UTURN_LEFT': 5, 'UTURN_RIGHT': 5,
  'TURN_SHARP_LEFT': 6, 'TURN_LEFT': 7,
  'TURN_SLIGHT_LEFT': 8, 'FORK_LEFT': 8, 'RAMP_LEFT': 8,
  'DESTINATION': 9, 'DESTINATION_LEFT': 9, 'DESTINATION_RIGHT': 9,
  'ROUNDABOUT_RIGHT': 10, 'ROUNDABOUT_LEFT': 11
};

function normalizeGoogleSteps(route) {
  var out = [];
  var legs = route.legs || [];
  for (var l = 0; l < legs.length; l++) {
    var gsteps = legs[l].steps || [];
    for (var i = 0; i < gsteps.length; i++) {
      var gs = gsteps[i];
      var ni = gs.navigationInstruction || {};
      var ll = (gs.startLocation && gs.startLocation.latLng) || {};
      out.push({
        distance: gs.distanceMeters || 0,
        name: '',
        maneuver: {
          instruction: ni.instructions || 'Continue',
          type: 'turn',
          modifier: '',
          location: [ll.longitude || 0, ll.latitude || 0],
          googleManeuver: ni.maneuver || ''
        }
      });
    }
  }
  return out;
}

function formatInstruction(step) {
  if (step.maneuver && step.maneuver.instruction) {
    return step.maneuver.instruction;
  }
  var maneuver = step.maneuver || {};
  var type = maneuver.type || 'proceed';
  var modifier = maneuver.modifier || '';
  var name = step.name || '';

  var action = 'Proceed';
  if (type === 'depart') {
    action = 'Head';
  } else if (type === 'turn') {
    action = 'Turn ' + modifier;
  } else if (type === 'continue') {
    action = modifier ? 'Continue ' + modifier : 'Continue';
  } else if (type === 'arrive') {
    action = 'Arrive';
  }

  if (name && type !== 'arrive') {
    return action + ' onto ' + name;
  } else if (name && type === 'arrive') {
    return 'Arrive at ' + name;
  }
  return action;
}

function sendStep(index) {
  if (index < 0 || index >= currentSteps.length) return;
  var step = currentSteps[index];
  var instruction = formatInstruction(step);
  var units = localStorage.getItem('units') || 'metric';
  var calcDistance = (units === 'imperial') ? step.distance * 3.28084 : step.distance;
  var distance = Math.round(calcDistance);
  console.log('Sending step ' + index + ': ' + instruction + ' (' + distance + (units === 'imperial' ? 'ft' : 'm') + ')');
  var maneuver = step.maneuver || {};
  var maneuverInt;
  if (maneuver.googleManeuver) {
    maneuverInt = GOOGLE_MANEUVER_INT[maneuver.googleManeuver];
    if (maneuverInt === undefined) maneuverInt = 1;
  } else {
    maneuverInt = maneuverToInt(maneuver.type, maneuver.modifier);
  }
  Pebble.sendAppMessage({
    'AppKeyStepIndex': index,
    'AppKeyManeuver': maneuverInt,
    'AppKeyStepCount': currentSteps.length,
    'AppKeyInstruction': instruction,
    'AppKeyDistance': distance,
    'AppKeyUnit': units === 'imperial' ? 'ft' : 'm'
  });
}

function beginRoute(steps) {
  if (!steps || steps.length === 0) {
    Pebble.sendAppMessage({ 'AppKeyInstruction': 'You have arrived!' });
    return;
  }
  currentSteps = steps;
  currentStepIndex = 0;
  sendStep(0);
  startWatching();
}

function routeMapbox(startLat, startLon, destLat, destLon) {
  var userToken = localStorage.getItem('mapboxToken');
  var mapboxToken = (userToken && userToken.length > 10) ? userToken : config.MAPBOX_TOKEN;
  var routeUrl = 'https://api.mapbox.com/directions/v5/mapbox/walking/' +
    startLon + ',' + startLat + ';' + destLon + ',' + destLat +
    '?steps=true&overview=false&walkway_bias=-1&access_token=' + mapboxToken;
  xhrRequest(routeUrl, 'GET', function (txt) {
    var j = JSON.parse(txt);
    if (j.code !== 'Ok' || !j.routes || j.routes.length === 0) {
      console.log('Mapbox: no route');
      Pebble.sendAppMessage({ 'AppKeyInstruction': 'No walking route found' });
      return;
    }
    beginRoute(j.routes[0].legs[0].steps);
  });
}

function routeGoogle(googleKey, startLat, startLon, destLat, destLon) {
  var body = {
    origin: { location: { latLng: { latitude: Number(startLat), longitude: Number(startLon) } } },
    destination: { location: { latLng: { latitude: Number(destLat), longitude: Number(destLon) } } },
    travelMode: 'WALK',
    languageCode: 'en-US'
  };
  var headers = {
    'Content-Type': 'application/json',
    'X-Goog-Api-Key': googleKey,
    'X-Goog-FieldMask': 'routes.distanceMeters,routes.legs.steps.distanceMeters,routes.legs.steps.startLocation,routes.legs.steps.navigationInstruction'
  };
  xhrPostJson('https://routes.googleapis.com/directions/v2:computeRoutes', headers, body,
    function (txt) {
      var j = JSON.parse(txt);
      if (!j.routes || j.routes.length === 0) {
        console.log('Google: no route, falling back to Mapbox');
        routeMapbox(startLat, startLon, destLat, destLon);
        return;
      }
      beginRoute(normalizeGoogleSteps(j.routes[0]));
    },
    function (err) {
      console.log('Google routing failed (' + err + '), falling back to Mapbox');
      routeMapbox(startLat, startLon, destLat, destLon);
    });
}

function getWalkingDirections(destinationQuery) {
  navigator.geolocation.getCurrentPosition(
    function (pos) {
      var startLon = pos.coords.longitude;
      var startLat = pos.coords.latitude;

      var geocodeUrl = 'https://nominatim.openstreetmap.org/search?format=json&q=' + encodeURIComponent(destinationQuery);
      xhrRequest(geocodeUrl, 'GET', function (responseText) {
        var json = JSON.parse(responseText);
        if (json.length === 0) {
          console.log('Location not found');
          Pebble.sendAppMessage({ 'AppKeyInstruction': 'Destination not found' });
          return;
        }
        var destLat = json[0].lat;
        var destLon = json[0].lon;

        var googleKey = localStorage.getItem('googleKey');
        if (googleKey && googleKey.length > 20) {
          console.log('Routing via Google');
          routeGoogle(googleKey, startLat, startLon, destLat, destLon);
        } else {
          console.log('Routing via Mapbox');
          routeMapbox(startLat, startLon, destLat, destLon);
        }
      });
    },
    function (err) {
      console.log('Error requesting geolocation: ' + err.code);
      Pebble.sendAppMessage({ 'AppKeyInstruction': 'GPS error' });
    },
    { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }
  );
}

Pebble.addEventListener('ready', function(e) {
  console.log('PebbleKit JS ready!');
  Pebble.sendAppMessage({ 'AppKeyReady': 1 });
});

Pebble.addEventListener('appmessage', function(e) {
  var dict = e.payload;
  if (dict['AppKeyDestination']) {
    var dest = dict['AppKeyDestination'];
    console.log('Destination received: ' + dest);
    getWalkingDirections(dest);
  }
  if (dict['AppKeyStepIndex'] !== undefined) {
    currentStepIndex = dict['AppKeyStepIndex'];
    sendStep(currentStepIndex);
  }
});

var configHtml = '<!DOCTYPE html><html><head><title>Settings</title><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{font-family:sans-serif;padding:20px;background-color:#f4f4f4;}select,input[type=text],button{font-size:16px;margin-top:15px;padding:10px;width:100%;border-radius:5px;border:1px solid #ccc;box-sizing:border-box;}</style></head><body><h2>Directions Settings</h2><label for="units">Preferred Units:</label><select id="units"><option value="metric">Metric (meters)</option><option value="imperial">Imperial (feet)</option></select><label for="autoAdvance">Auto-advance steps:</label><select id="autoAdvance"><option value="on">On (GPS auto-advance)</option><option value="off">Off (manual only)</option></select><label for="mapboxToken">Mapbox API Key (optional):</label><input type="text" id="mapboxToken" placeholder="Leave blank to use default"><p style="font-size:12px;color:#666;margin-top:5px;">Only needed if the default key stops working. Get a free key at mapbox.com.</p><label for="googleKey">Google Routes API Key (optional):</label><input type="text" id="googleKey" placeholder="Leave blank to use Mapbox"><p style="font-size:12px;color:#666;margin-top:5px;">Directions are more accurate with your own Google Routes API key. Without one the app uses Mapbox, which may route you along unnamed walkways and crosswalks. A Google key is free for personal use at this volume (10,000 routes/month). Get one at console.cloud.google.com.</p><button id="save">Save Settings</button><script>var unitsSelect=document.getElementById("units");unitsSelect.value=unitsSelect.getAttribute("data-current")||"metric";var advanceSelect=document.getElementById("autoAdvance");advanceSelect.value=advanceSelect.getAttribute("data-current")||"on";document.getElementById("save").onclick=function(){var cfg={units:unitsSelect.value,autoAdvance:advanceSelect.value,mapboxToken:document.getElementById("mapboxToken").value,googleKey:document.getElementById("googleKey").value};window.location.href="pebblejs://close#"+encodeURIComponent(JSON.stringify(cfg));};</script></body></html>';

Pebble.addEventListener('showConfiguration', function() {
  var currentUnits = localStorage.getItem('units') || 'metric';
  var currentAdvance = localStorage.getItem('autoAdvance') || 'on';
  var currentToken = localStorage.getItem('mapboxToken') || '';
  var currentGoogle = localStorage.getItem('googleKey') || '';
  var populatedHtml = configHtml.replace('id="units"', 'id="units" data-current="' + currentUnits + '"');
  populatedHtml = populatedHtml.replace('id="autoAdvance"', 'id="autoAdvance" data-current="' + currentAdvance + '"');
  populatedHtml = populatedHtml.replace('id="mapboxToken"', 'id="mapboxToken" value="' + currentToken + '"');
  populatedHtml = populatedHtml.replace('id="googleKey"', 'id="googleKey" value="' + currentGoogle + '"');
  var gpsLog = JSON.parse(localStorage.getItem('gpsLog') || '[]');
  populatedHtml = populatedHtml.replace('<button id="save">',
    '<h3>GPS Log (' + gpsLog.length + ')</h3><textarea readonly rows="12" style="width:100%;font-family:monospace;font-size:11px;">' +
    gpsLog.join('\n') + '</textarea><button id="save">');
  var dataUri = 'data:text/html;charset=utf-8,' + encodeURIComponent(populatedHtml);
  Pebble.openURL(dataUri);
});

Pebble.addEventListener('webviewclosed', function(e) {
  if (e && e.response && e.response !== 'CANCELLED') {
    try {
      var cfg = JSON.parse(decodeURIComponent(e.response));
      localStorage.setItem('units', cfg.units);
      localStorage.setItem('autoAdvance', cfg.autoAdvance || 'on');
      if (cfg.mapboxToken && cfg.mapboxToken.length > 10) {
        localStorage.setItem('mapboxToken', cfg.mapboxToken);
      } else {
        localStorage.removeItem('mapboxToken');
      }
      if (cfg.googleKey && cfg.googleKey.length > 20) {
        localStorage.setItem('googleKey', cfg.googleKey);
      } else {
        localStorage.removeItem('googleKey');
      }
      console.log('Routing provider: ' + (cfg.googleKey && cfg.googleKey.length > 20 ? 'Google' : 'Mapbox'));
      console.log('Config saved. Units: ' + cfg.units + ', autoAdvance: ' + cfg.autoAdvance + ', mapboxToken: ' + (cfg.mapboxToken ? 'user key' : 'default'));
    } catch (err) {
      console.log('Error parsing config: ' + err);
    }
  }
});

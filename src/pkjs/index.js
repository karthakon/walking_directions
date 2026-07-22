var config = require('./config');

var xhrRequest = function (url, type, callback) {
  var xhr = new XMLHttpRequest();
  xhr.onload = function () {
    callback(this.responseText);
  };
  xhr.open(type, url);
  xhr.send();
};

var currentSteps = [];
var currentStepIndex = 0;
var watchId = null;

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

function startWatching() {
  stopWatching();
  watchId = navigator.geolocation.watchPosition(
    function(pos) {
      if (currentSteps.length === 0) return;
      var nextIndex = currentStepIndex + 1;
      if (nextIndex >= currentSteps.length) return;
      var waypoint = currentSteps[nextIndex].maneuver.location;
      var dist = haversineMeters(pos.coords.latitude, pos.coords.longitude, waypoint[1], waypoint[0]);
      console.log('GPS tick: ' + dist.toFixed(1) + 'm to step ' + nextIndex);
      if (localStorage.getItem('autoAdvance') !== 'off' && dist < 20) {
        currentStepIndex = nextIndex;
        sendStep(currentStepIndex);
        if (currentStepIndex === currentSteps.length - 1) {
          console.log('Arrived at destination, clearing GPS watch.');
          stopWatching();
        }
      }
    },
    function(err) { console.log('watchPosition error: ' + err.code); },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 }
  );
  console.log('GPS watch started.');
}

function formatInstruction(step) {
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
  Pebble.sendAppMessage({
    'AppKeyStepIndex': index,
    'AppKeyStepCount': currentSteps.length,
    'AppKeyInstruction': instruction,
    'AppKeyDistance': distance,
    'AppKeyUnit': units === 'imperial' ? 'ft' : 'm'
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

        var userToken = localStorage.getItem('mapboxToken');
        var mapboxToken = (userToken && userToken.length > 10) ? userToken : config.MAPBOX_TOKEN;
        var routeUrl = 'https://api.mapbox.com/directions/v5/mapbox/walking/' +
          startLon + ',' + startLat + ';' + destLon + ',' + destLat +
          '?steps=true&overview=false&access_token=' + mapboxToken;

        xhrRequest(routeUrl, 'GET', function (routeResponseText) {
          var routeJson = JSON.parse(routeResponseText);
          if (routeJson.code !== 'Ok' || !routeJson.routes || routeJson.routes.length === 0) {
            console.log('No route found');
            Pebble.sendAppMessage({ 'AppKeyInstruction': 'No walking route found' });
            return;
          }

          var steps = routeJson.routes[0].legs[0].steps;
          if (steps.length === 0) {
            Pebble.sendAppMessage({ 'AppKeyInstruction': 'You have arrived!' });
            return;
          }

          currentSteps = steps;
          currentStepIndex = 0;
          sendStep(0);
          startWatching();
        });
      });
    },
    function (err) {
      console.log('Error requesting geolocation: ' + err.code);
      Pebble.sendAppMessage({ 'AppKeyInstruction': 'GPS error' });
    },
    { timeout: 15000, maximumAge: 60000 }
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

var configHtml = '<!DOCTYPE html><html><head><title>Settings</title><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{font-family:sans-serif;padding:20px;background-color:#f4f4f4;}select,input[type=text],button{font-size:16px;margin-top:15px;padding:10px;width:100%;border-radius:5px;border:1px solid #ccc;box-sizing:border-box;}</style></head><body><h2>Directions Settings</h2><label for="units">Preferred Units:</label><select id="units"><option value="metric">Metric (meters)</option><option value="imperial">Imperial (feet)</option></select><label for="autoAdvance">Auto-advance steps:</label><select id="autoAdvance"><option value="on">On (GPS auto-advance)</option><option value="off">Off (manual only)</option></select><label for="mapboxToken">Mapbox API Key (optional):</label><input type="text" id="mapboxToken" placeholder="Leave blank to use default"><p style="font-size:12px;color:#666;margin-top:5px;">Only needed if the default key stops working. Get a free key at mapbox.com.</p><button id="save">Save Settings</button><script>var unitsSelect=document.getElementById("units");unitsSelect.value=unitsSelect.getAttribute("data-current")||"metric";var advanceSelect=document.getElementById("autoAdvance");advanceSelect.value=advanceSelect.getAttribute("data-current")||"on";document.getElementById("save").onclick=function(){var cfg={units:unitsSelect.value,autoAdvance:advanceSelect.value,mapboxToken:document.getElementById("mapboxToken").value};window.location.href="pebblejs://close#"+encodeURIComponent(JSON.stringify(cfg));};</script></body></html>';

Pebble.addEventListener('showConfiguration', function() {
  var currentUnits = localStorage.getItem('units') || 'metric';
  var currentAdvance = localStorage.getItem('autoAdvance') || 'on';
  var currentToken = localStorage.getItem('mapboxToken') || '';
  var populatedHtml = configHtml.replace('id="units"', 'id="units" data-current="' + currentUnits + '"');
  populatedHtml = populatedHtml.replace('id="autoAdvance"', 'id="autoAdvance" data-current="' + currentAdvance + '"');
  populatedHtml = populatedHtml.replace('id="mapboxToken"', 'id="mapboxToken" value="' + currentToken + '"');
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
      console.log('Config saved. Units: ' + cfg.units + ', autoAdvance: ' + cfg.autoAdvance + ', mapboxToken: ' + (cfg.mapboxToken ? 'user key' : 'default'));
    } catch (err) {
      console.log('Error parsing config: ' + err);
    }
  }
});

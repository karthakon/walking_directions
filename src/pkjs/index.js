var xhrRequest = function (url, type, callback) {
  var xhr = new XMLHttpRequest();
  xhr.onload = function () {
    callback(this.responseText);
  };
  xhr.open(type, url);
  xhr.send();
};

var currentSteps = [];

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

        var routeUrl = 'https://router.project-osrm.org/route/v1/walking/' + startLon + ',' + startLat + ';' + destLon + ',' + destLat + '?steps=true&overview=false';
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
          sendStep(0);
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
    sendStep(dict['AppKeyStepIndex']);
  }
});

var configHtml = '<!DOCTYPE html><html><head><title>Settings</title><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{font-family:sans-serif;padding:20px;background-color:#f4f4f4;}select,button{font-size:18px;margin-top:15px;padding:10px;width:100%;border-radius:5px;border:1px solid #ccc;}</style></head><body><h2>Directions Settings</h2><label for="units">Preferred Units:</label><select id="units"><option value="metric">Metric (meters)</option><option value="imperial">Imperial (feet)</option></select><button id="save">Save Settings</button><script>var unitsSelect = document.getElementById("units");var currentUnits = unitsSelect.getAttribute("data-current") || "metric";unitsSelect.value = currentUnits;document.getElementById("save").onclick = function() {var config = { units: unitsSelect.value };window.location.href = "pebblejs://close#" + encodeURIComponent(JSON.stringify(config));};</script></body></html>';

Pebble.addEventListener('showConfiguration', function() {
  var currentUnits = localStorage.getItem('units') || 'metric';
  // Inject the current setting into the HTML payload before encoding
  var populatedHtml = configHtml.replace('id="units"', 'id="units" data-current="' + currentUnits + '"');
  var dataUri = 'data:text/html;charset=utf-8,' + encodeURIComponent(populatedHtml);
  Pebble.openURL(dataUri);
});

Pebble.addEventListener('webviewclosed', function(e) {
  if (e && e.response && e.response !== 'CANCELLED') {
    try {
      var config = JSON.parse(decodeURIComponent(e.response));
      localStorage.setItem('units', config.units);
      console.log('Configuration saved. Units: ' + config.units);
    } catch (err) {
      console.log('Error parsing config: ' + err);
    }
  }
});

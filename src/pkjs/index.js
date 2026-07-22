var xhrRequest = function (url, type, callback) {
  var xhr = new XMLHttpRequest();
  xhr.onload = function () {
    callback(this.responseText);
  };
  xhr.open(type, url);
  xhr.send();
};

var currentSteps = [];

function sendStep(index) {
  if (index < 0 || index >= currentSteps.length) return;
  var step = currentSteps[index];
  var instruction = step.maneuver && step.maneuver.instruction ? step.maneuver.instruction : (step.name || "Proceed");
  var distance = Math.round(step.distance);
  
  console.log("Sending step " + index + ": " + instruction + " (" + distance + "m)");
  Pebble.sendAppMessage({
    'AppKeyStepIndex': index,
    'AppKeyStepCount': currentSteps.length,
    'AppKeyInstruction': instruction,
    'AppKeyDistance': distance
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

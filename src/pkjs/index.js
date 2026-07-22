Pebble.addEventListener('ready', function(e) {
  console.log('PebbleKit JS ready!');
  Pebble.sendAppMessage({ 'AppKeyReady': 1 });
});

Pebble.addEventListener('appmessage', function(e) {
  var dict = e.payload;
  if (dict['AppKeyDestination']) {
    console.log('Destination received: ' + dict['AppKeyDestination']);
    // Geocoding and routing to follow
  }
});

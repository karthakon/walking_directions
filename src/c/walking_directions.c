#include <pebble.h>

static Window *s_window;
static TextLayer *s_text_layer;
static DictationSession *s_dictation_session;
static char s_last_text[512];

static void dictation_session_callback(DictationSession *session, DictationSessionStatus status, char *transcription, void *context) {
  if(status == DictationSessionStatusSuccess) {
    snprintf(s_last_text, sizeof(s_last_text), "Routing:\n%s", transcription);
    text_layer_set_text(s_text_layer, s_last_text);

    DictionaryIterator *iter;
    app_message_outbox_begin(&iter);
    dict_write_cstring(iter, MESSAGE_KEY_AppKeyDestination, transcription);
    app_message_outbox_send();
  } else {
    text_layer_set_text(s_text_layer, "Dictation failed.");
  }
}

static void inbox_received_callback(DictionaryIterator *iterator, void *context) {
  Tuple *instruction_tuple = dict_find(iterator, MESSAGE_KEY_AppKeyInstruction);
  if(instruction_tuple) {
    snprintf(s_last_text, sizeof(s_last_text), "%s", instruction_tuple->value->cstring);
    text_layer_set_text(s_text_layer, s_last_text);
  }
}

static void prv_select_click_handler(ClickRecognizerRef recognizer, void *context) {
  dictation_session_start(s_dictation_session);
}

static void prv_click_config_provider(void *context) {
  window_single_click_subscribe(BUTTON_ID_SELECT, prv_select_click_handler);
}

static void prv_window_load(Window *window) {
  Layer *window_layer = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(window_layer);

  s_text_layer = text_layer_create(GRect(5, 5, bounds.size.w - 10, bounds.size.h - 10));
  text_layer_set_font(s_text_layer, fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD));
  text_layer_set_text(s_text_layer, "Press Select to dictate");
  text_layer_set_text_alignment(s_text_layer, GTextAlignmentCenter);
  text_layer_set_overflow_mode(s_text_layer, GTextOverflowModeWordWrap);
  layer_add_child(window_layer, text_layer_get_layer(s_text_layer));
}

static void prv_window_unload(Window *window) {
  text_layer_destroy(s_text_layer);
}

static void prv_init(void) {
  s_window = window_create();
  window_set_click_config_provider(s_window, prv_click_config_provider);
  window_set_window_handlers(s_window, (WindowHandlers) {
    .load = prv_window_load,
    .unload = prv_window_unload,
  });
  const bool animated = true;
  window_stack_push(s_window, animated);

  app_message_register_inbox_received(inbox_received_callback);
  app_message_open(512, 512);

  s_dictation_session = dictation_session_create(sizeof(s_last_text), dictation_session_callback, NULL);
  dictation_session_enable_confirmation(s_dictation_session, true);
}

static void prv_deinit(void) {
  dictation_session_destroy(s_dictation_session);
  window_destroy(s_window);
}

int main(void) {
  prv_init();

  APP_LOG(APP_LOG_LEVEL_DEBUG, "Done initializing, pushed window: %p", s_window);

  app_event_loop();
  prv_deinit();
}

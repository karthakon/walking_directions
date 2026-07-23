#include <pebble.h>

/* ── Layout ─────────────────────────────────────────────────────────────────── */
#define DIVIDER_H 3
static int16_t s_banner_h;

static const GPoint STRAIGHT_PTS[] = {
  { 0,-30},{15,-12},{ 6,-12},{ 6,28},{-6,28},{-6,-12},{-15,-12}
};
static const GPathInfo STRAIGHT_INFO = {7,(GPoint*)STRAIGHT_PTS};

static const GPoint SLIGHT_RIGHT_PTS[] = {
  {10,-28},{18,-6},{10,-9},{-4,28},{-15,24},{-2,-13},{-10,-16}
};
static const GPathInfo SLIGHT_RIGHT_INFO = {7,(GPoint*)SLIGHT_RIGHT_PTS};

static const GPoint TURN_RIGHT_PTS[] = {
  {-15,28},{-15,-6},{14,-6},{14,-18},{30,0},{14,18},{14,6},{-4,6},{-4,28}
};
static const GPathInfo TURN_RIGHT_INFO = {9,(GPoint*)TURN_RIGHT_PTS};

static const GPoint TURN_LEFT_PTS[] = {
  {15,28},{15,-6},{-14,-6},{-14,-18},{-30,0},{-14,18},{-14,6},{4,6},{4,28}
};
static const GPathInfo TURN_LEFT_INFO = {9,(GPoint*)TURN_LEFT_PTS};

static const GPoint SLIGHT_LEFT_PTS[] = {
  {-10,-28},{-18,-6},{-10,-9},{4,28},{15,24},{2,-13},{10,-16}
};
static const GPathInfo SLIGHT_LEFT_INFO = {7,(GPoint*)SLIGHT_LEFT_PTS};

static const GPoint ARRIVE_PTS[] = {
  {0,30},{15,12},{6,12},{6,-28},{-6,-28},{-6,12},{-15,12}
};
static const GPathInfo ARRIVE_INFO = {7,(GPoint*)ARRIVE_PTS};

static Window    *s_window;
static Layer     *s_banner_layer;
static TextLayer *s_street_layer;

static DictationSession *s_dictation_session;
static char s_dictation_buf[256];

static int  s_current_step_index = 0;
static int  s_total_steps        = 0;
static int  s_maneuver           = 0;

static char s_distance_text[16] = "";
static char s_unit_text[4]      = "";
static char s_counter_text[16]  = "";
static char s_street_text[256]  = "Press Select\nto navigate";

static GColor banner_bg(int m) {
#ifdef PBL_COLOR
  switch (m) {
    case 2: case 3: case 7: case 8: case 10: case 11: return GColorChromeYellow;
    case 4: case 6:                                    return GColorOrange;
    case 5:                                            return GColorRed;
    case 9:                                            return GColorPictonBlue;
    default:                                           return GColorIslamicGreen;
  }
#else
  (void)m; return GColorBlack;
#endif
}

static GColor banner_fg(int m) {
  switch (m) {
    case 2: case 3: case 7: case 8: case 10: case 11:
      return PBL_IF_COLOR_ELSE(GColorBlack, GColorWhite);
    default: return GColorWhite;
  }
}

static void draw_uturn(GContext *ctx, GPoint c) {
  int cx = c.x, cy = c.y;
  graphics_fill_rect(ctx, GRect(cx-12, cy-22, 10, 40), 0, GCornerNone);
  graphics_fill_rect(ctx, GRect(cx-12, cy-22, 24, 10), 0, GCornerNone);
  graphics_fill_rect(ctx, GRect(cx+2,  cy-12, 10, 18), 0, GCornerNone);
  GPoint tri[3] = {{cx-4,cy+6},{cx+18,cy+6},{cx+7,cy+26}};
  GPathInfo hi  = {3, tri};
  GPath *p = gpath_create(&hi);
  gpath_draw_filled(ctx, p);
  gpath_destroy(p);
}

static void banner_update_proc(Layer *layer, GContext *ctx) {
  GRect b = layer_get_bounds(layer);
  int w = b.size.w, h = b.size.h;

  graphics_context_set_fill_color(ctx, banner_bg(s_maneuver));
  graphics_fill_rect(ctx, b, 0, GCornerNone);

  GColor fg = banner_fg(s_maneuver);
  int lw = w / 2 - 6;

  graphics_context_set_text_color(ctx, fg);

  if (s_counter_text[0])
    graphics_draw_text(ctx, s_counter_text,
      fonts_get_system_font(FONT_KEY_GOTHIC_18),
      GRect(6, 3, lw, 20),
      GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);

  if (s_distance_text[0])
    graphics_draw_text(ctx, s_distance_text,
      fonts_get_system_font(FONT_KEY_BITHAM_42_BOLD),
      GRect(5, 22, lw, 50),
      GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);

  if (s_unit_text[0]) {
    int unit_y = (h >= 115) ? 74 : (h - 22);
    graphics_draw_text(ctx, s_unit_text,
      fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD),
      GRect(5, unit_y, lw, 22),
      GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
  }

  graphics_context_set_stroke_color(ctx, fg);
  graphics_draw_line(ctx, GPoint(0, h-1), GPoint(w-1, h-1));

  GPoint ac = GPoint(w * 3 / 4, h / 2);
  graphics_context_set_fill_color(ctx, fg);

  if (s_maneuver == 5) { draw_uturn(ctx, ac); return; }

  const GPathInfo *info;
  switch (s_maneuver) {
    case 2:                   info = &SLIGHT_RIGHT_INFO; break;
    case 3: case 4: case 10:  info = &TURN_RIGHT_INFO;   break;
    case 6: case 7: case 11:  info = &TURN_LEFT_INFO;    break;
    case 8:                   info = &SLIGHT_LEFT_INFO;  break;
    case 9:                   info = &ARRIVE_INFO;       break;
    default:                  info = &STRAIGHT_INFO;     break;
  }
  GPath *arrow = gpath_create(info);
  gpath_move_to(arrow, ac);
  gpath_draw_filled(ctx, arrow);
  gpath_destroy(arrow);
}

static void request_step(int index) {
  DictionaryIterator *iter;
  app_message_outbox_begin(&iter);
  dict_write_int32(iter, MESSAGE_KEY_AppKeyStepIndex, index);
  app_message_outbox_send();
}

static void inbox_received_callback(DictionaryIterator *iterator, void *context) {
  Tuple *instr_t    = dict_find(iterator, MESSAGE_KEY_AppKeyInstruction);
  Tuple *index_t    = dict_find(iterator, MESSAGE_KEY_AppKeyStepIndex);
  Tuple *count_t    = dict_find(iterator, MESSAGE_KEY_AppKeyStepCount);
  Tuple *distance_t = dict_find(iterator, MESSAGE_KEY_AppKeyDistance);
  Tuple *unit_t     = dict_find(iterator, MESSAGE_KEY_AppKeyUnit);
  Tuple *maneuver_t = dict_find(iterator, MESSAGE_KEY_AppKeyManeuver);

  if (!instr_t) return;

  if (index_t && count_t) {
    s_current_step_index = (int)index_t->value->int32;
    s_total_steps        = (int)count_t->value->int32;
    if (maneuver_t) s_maneuver = (int)maneuver_t->value->int32;
    if (distance_t) snprintf(s_distance_text, sizeof(s_distance_text),
                             "%d", (int)distance_t->value->int32);
    if (unit_t)     snprintf(s_unit_text, sizeof(s_unit_text),
                             "%s", unit_t->value->cstring);
    snprintf(s_counter_text, sizeof(s_counter_text),
             "%d/%d", s_current_step_index + 1, s_total_steps);
  } else {
    s_maneuver         = 0;
    s_distance_text[0] = '\0';
    s_unit_text[0]     = '\0';
    s_counter_text[0]  = '\0';
  }

  snprintf(s_street_text, sizeof(s_street_text), "%s", instr_t->value->cstring);
  text_layer_set_text(s_street_layer, s_street_text);
  layer_mark_dirty(s_banner_layer);
  vibes_short_pulse();
}

static void dictation_session_callback(DictationSession *session,
                                       DictationSessionStatus status,
                                       char *transcription, void *context) {
  if (status == DictationSessionStatusSuccess) {
    s_maneuver         = 0;
    s_distance_text[0] = '\0';
    s_unit_text[0]     = '\0';
    s_counter_text[0]  = '\0';
    snprintf(s_street_text, sizeof(s_street_text), "Routing:\n%s", transcription);
    text_layer_set_text(s_street_layer, s_street_text);
    layer_mark_dirty(s_banner_layer);

    DictionaryIterator *iter;
    app_message_outbox_begin(&iter);
    dict_write_cstring(iter, MESSAGE_KEY_AppKeyDestination, transcription);
    app_message_outbox_send();
  } else {
    snprintf(s_street_text, sizeof(s_street_text), "Dictation\nfailed.");
    text_layer_set_text(s_street_layer, s_street_text);
  }
}

static void up_click(ClickRecognizerRef r, void *ctx) {
  if (s_current_step_index > 0) request_step(s_current_step_index - 1);
}
static void down_click(ClickRecognizerRef r, void *ctx) {
  if (s_current_step_index < s_total_steps - 1)
    request_step(s_current_step_index + 1);
}
static void select_click(ClickRecognizerRef r, void *ctx) {
  dictation_session_start(s_dictation_session);
}
static void click_config_provider(void *ctx) {
  window_single_click_subscribe(BUTTON_ID_UP,     up_click);
  window_single_click_subscribe(BUTTON_ID_DOWN,   down_click);
  window_single_click_subscribe(BUTTON_ID_SELECT, select_click);
}

static void prv_window_load(Window *window) {
  Layer *root   = window_get_root_layer(window);
  GRect  bounds = layer_get_bounds(root);

  s_banner_h = (bounds.size.h <= 168) ? 90 : 120;

  window_set_background_color(window, GColorWhite);

  s_banner_layer = layer_create(GRect(0, 0, bounds.size.w, s_banner_h));
  layer_set_update_proc(s_banner_layer, banner_update_proc);
  layer_add_child(root, s_banner_layer);

  int sy = s_banner_h + DIVIDER_H;
  s_street_layer = text_layer_create(
    GRect(5, sy + 4, bounds.size.w - 10, bounds.size.h - sy - 4));
  text_layer_set_font(s_street_layer,
    fonts_get_system_font(FONT_KEY_GOTHIC_28_BOLD));
  text_layer_set_text(s_street_layer, s_street_text);
  text_layer_set_text_alignment(s_street_layer, GTextAlignmentLeft);
  text_layer_set_overflow_mode(s_street_layer, GTextOverflowModeWordWrap);
  text_layer_set_background_color(s_street_layer, GColorWhite);
  text_layer_set_text_color(s_street_layer, GColorBlack);
  layer_add_child(root, text_layer_get_layer(s_street_layer));
}

static void prv_window_unload(Window *window) {
  layer_destroy(s_banner_layer);
  text_layer_destroy(s_street_layer);
}

static void prv_init(void) {
  s_window = window_create();
  window_set_click_config_provider(s_window, click_config_provider);
  window_set_window_handlers(s_window, (WindowHandlers){
    .load   = prv_window_load,
    .unload = prv_window_unload,
  });
  window_stack_push(s_window, true);

  app_message_register_inbox_received(inbox_received_callback);
  app_message_open(512, 512);

  s_dictation_session = dictation_session_create(
    sizeof(s_dictation_buf), dictation_session_callback, NULL);
  dictation_session_enable_confirmation(s_dictation_session, true);
}

static void prv_deinit(void) {
  dictation_session_destroy(s_dictation_session);
  window_destroy(s_window);
}

int main(void) {
  prv_init();
  APP_LOG(APP_LOG_LEVEL_DEBUG, "walking_directions init ok");
  app_event_loop();
  prv_deinit();
}

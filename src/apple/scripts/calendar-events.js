// Leash: events from the named calendars that overlap [from, to].
// Arg: {"calendars": ["Leash Demo"], "from": ISO, "to": ISO}
// Prints: [{id, calendar, title, start, end, location, notes}] or {error: {app, code, message}}
// Looks up only the named calendars (byName). Never iterates all calendars: big synced ones cost seconds each.

function run(argv) {
  var APP = 'Calendar';
  function fail(error) {
    var code = error && typeof error.errorNumber === 'number' ? error.errorNumber : null;
    var message = String((error && error.message) || error);
    if (code === null) { var m = /\((-\d+)\)/.exec(message); if (m) code = Number(m[1]); }
    return JSON.stringify({ error: { app: APP, code: code, message: message } });
  }
  function notFound(what) { var e = new Error(what); e.errorNumber = -1728; return e; }
  function iso(d) { return d && typeof d.toISOString === 'function' ? d.toISOString() : null; }
  function text(v) { return v === null || v === undefined ? null : String(v); }

  try {
    var args = JSON.parse(argv[0] || '{}');
    var names = Array.isArray(args.calendars) ? args.calendars : [];
    var start = args.from ? new Date(args.from) : new Date();
    var end = args.to ? new Date(args.to) : new Date(start.getTime() + 7 * 864e5);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) throw new Error('from and to must be ISO dates');
    var Calendar = Application(APP);
    var out = [];
    for (var i = 0; i < names.length; i++) {
      var name = String(names[i]);
      var cal = Calendar.calendars.byName(name);
      if (!cal.exists()) throw notFound('Calendar not found: ' + name);
      var spec = cal.events.whose({ startDate: { _lessThanEquals: end }, endDate: { _greaterThanEquals: start } });
      var ids = spec.uid();
      if (!ids.length) continue;
      var titles = spec.summary();
      var starts = spec.startDate();
      var ends = spec.endDate();
      var locations = spec.location();
      var notes = spec.description();
      for (var j = 0; j < ids.length; j++) {
        out.push({ id: String(ids[j]), calendar: name, title: text(titles[j]), start: iso(starts[j]), end: iso(ends[j]), location: text(locations[j]), notes: text(notes[j]) });
      }
    }
    out.sort(function (a, b) { return String(a.start).localeCompare(String(b.start)); });
    return JSON.stringify(out);
  } catch (error) {
    return fail(error);
  }
}

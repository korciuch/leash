// Leash: reminders in the named lists.
// Arg: {"lists": ["Errands"], "includeCompleted": false}
// Prints: [{id, list, title, notes, completed, due}] or {error: {app, code, message}}
// Looks up only the named lists (byName).

function run(argv) {
  var APP = 'Reminders';
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
    var names = Array.isArray(args.lists) ? args.lists : [];
    var includeCompleted = args.includeCompleted === true;
    var Reminders = Application(APP);
    var out = [];
    for (var i = 0; i < names.length; i++) {
      var name = String(names[i]);
      var list = Reminders.lists.byName(name);
      if (!list.exists()) throw notFound('Reminders list not found: ' + name);
      var spec = includeCompleted ? list.reminders : list.reminders.whose({ completed: false });
      var ids = spec.id();
      if (!ids.length) continue;
      var titles = spec.name();
      var bodies = spec.body();
      var done = spec.completed();
      var dues = spec.dueDate();
      for (var j = 0; j < ids.length; j++) {
        out.push({ id: String(ids[j]), list: name, title: text(titles[j]), notes: text(bodies[j]), completed: done[j] === true, due: iso(dues[j]) });
      }
    }
    return JSON.stringify(out);
  } catch (error) {
    return fail(error);
  }
}

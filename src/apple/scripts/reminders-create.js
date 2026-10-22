// Leash: add one reminder to a named list.
// Arg: {"list": "Errands", "title": "Buy stamps", "notes": "optional"}
// Prints: {id, list, title} or {error: {app, code, message}}

function run(argv) {
  var APP = 'Reminders';
  function fail(error) {
    var code = error && typeof error.errorNumber === 'number' ? error.errorNumber : null;
    var message = String((error && error.message) || error);
    if (code === null) { var m = /\((-\d+)\)/.exec(message); if (m) code = Number(m[1]); }
    return JSON.stringify({ error: { app: APP, code: code, message: message } });
  }
  function notFound(what) { var e = new Error(what); e.errorNumber = -1728; return e; }

  try {
    var args = JSON.parse(argv[0] || '{}');
    var name = String(args.list || '');
    var title = String(args.title || '');
    if (!title) throw new Error('A reminder needs a title');
    var Reminders = Application(APP);
    var list = Reminders.lists.byName(name);
    if (!list.exists()) throw notFound('Reminders list not found: ' + name);
    var props = { name: title };
    if (args.notes) props.body = String(args.notes);
    var item = Reminders.Reminder(props);
    list.reminders.push(item);
    var id = null;
    try { id = item.id(); } catch (e) {
      var found = list.reminders.whose({ name: title, completed: false })();
      if (found.length) id = found[found.length - 1].id();
    }
    return JSON.stringify({ id: id === null ? null : String(id), list: name, title: title });
  } catch (error) {
    return fail(error);
  }
}

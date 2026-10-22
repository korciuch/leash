// Leash: launch one app and make one cheap call, to warm it up and to check the Automation permission.
// Arg: {"app": "Calendar" | "Reminders" | "Mail" | "Messages"}
// Prints: {app, ok: true, count, ms} or {error: {app, code, message}}

function run(argv) {
  var app = 'unknown';
  function fail(error) {
    var code = error && typeof error.errorNumber === 'number' ? error.errorNumber : null;
    var message = String((error && error.message) || error);
    if (code === null) { var m = /\((-\d+)\)/.exec(message); if (m) code = Number(m[1]); }
    return JSON.stringify({ error: { app: app, code: code, message: message } });
  }

  try {
    var args = JSON.parse(argv[0] || '{}');
    app = String(args.app || '');
    var started = Date.now();
    var count;
    if (app === 'Calendar') count = Application('Calendar').calendars.length;
    else if (app === 'Reminders') count = Application('Reminders').lists.length;
    else if (app === 'Mail') count = Application('Mail').accounts.length;
    else if (app === 'Messages') {
      var Messages = Application('Messages');
      try { count = Messages.services.length; } catch (e) {
        if (e && e.errorNumber === -1743) throw e;
        count = Messages.accounts.length;
      }
    } else throw new Error('Leash only talks to Calendar, Reminders, Mail and Messages, not ' + app);
    return JSON.stringify({ app: app, ok: true, count: count, ms: Date.now() - started });
  } catch (error) {
    return fail(error);
  }
}

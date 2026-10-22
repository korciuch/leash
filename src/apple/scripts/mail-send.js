// Leash: send one email from the default Mail account. Only runs after Touch ID approval.
// Arg: {"to": ["a@example.com"], "subject": "Re: lunch", "body": "text"}
// Prints: {sent: true} or {error: {app, code, message}}

function run(argv) {
  var APP = 'Mail';
  function fail(error) {
    var code = error && typeof error.errorNumber === 'number' ? error.errorNumber : null;
    var message = String((error && error.message) || error);
    if (code === null) { var m = /\((-\d+)\)/.exec(message); if (m) code = Number(m[1]); }
    return JSON.stringify({ error: { app: APP, code: code, message: message } });
  }

  try {
    var args = JSON.parse(argv[0] || '{}');
    var to = Array.isArray(args.to) ? args.to : [args.to];
    to = to.filter(function (a) { return typeof a === 'string' && a.indexOf('@') > 0; });
    if (!to.length) throw new Error('No valid recipient address');
    var Mail = Application(APP);
    var msg = Mail.OutgoingMessage({ subject: String(args.subject || ''), content: String(args.body || ''), visible: false });
    Mail.outgoingMessages.push(msg);
    for (var i = 0; i < to.length; i++) msg.toRecipients.push(Mail.Recipient({ address: to[i] }));
    msg.send();
    return JSON.stringify({ sent: true, to: to.length });
  } catch (error) {
    return fail(error);
  }
}

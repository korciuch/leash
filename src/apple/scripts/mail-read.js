// Leash: one message by id from one mailbox.
// Arg: {"account": "Alumni", "mailbox": "Leash Demo", "id": "12345"}
// Prints: {id, account, mailbox, from, to, subject, date, body} or {error: {app, code, message}}

function run(argv) {
  var APP = 'Mail';
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
    var account = String(args.account || 'Alumni');
    var mailboxName = String(args.mailbox || '');
    var id = Number(args.id);
    if (!isFinite(id)) throw notFound('Message id must be a number: ' + String(args.id));
    var Mail = Application(APP);
    var local = account === 'On My Mac' || account === 'local';
    var boxes;
    if (local) {
      boxes = Mail.mailboxes;
    } else {
      var acct = Mail.accounts.byName(account);
      if (!acct.exists()) throw notFound('Mail account not found: ' + account);
      boxes = acct.mailboxes;
    }
    var box = boxes.byName(mailboxName);
    if (!box.exists()) throw notFound('Mailbox not found: ' + mailboxName + ' in ' + account);
    var found = box.messages.whose({ id: id })();
    if (!found.length) throw notFound('Message not found: ' + String(args.id) + ' in ' + mailboxName);
    var msg = found[0];
    var to = [];
    try { to = msg.toRecipients.address(); } catch (e) { to = []; }
    return JSON.stringify({
      id: String(msg.id()),
      account: account,
      mailbox: mailboxName,
      from: text(msg.sender()),
      to: to.map(String).join(', '),
      subject: text(msg.subject()),
      date: iso(msg.dateReceived()),
      body: text(msg.content())
    });
  } catch (error) {
    return fail(error);
  }
}

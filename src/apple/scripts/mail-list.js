// Leash: newest messages in one mailbox (a Gmail label shows up as a mailbox).
// Arg: {"account": "Alumni", "mailbox": "Leash Demo", "sinceDays": 30, "limit": 20, "scanLimit": 200}
// account "On My Mac" or "local" means Mail.mailboxes (local folders).
// Prints: [{id, account, mailbox, from, subject, date, read}] newest first, or {error: {app, code, message}}
// Slices are clamped to the mailbox's message count: slicing past it throws -1719.

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
    var limit = Math.max(1, Math.min(100, Math.floor(Number(args.limit) || 20)));
    var sinceDays = Number(args.sinceDays) > 0 ? Number(args.sinceDays) : null;
    var scanLimit = Math.max(limit, Math.min(500, Math.floor(Number(args.scanLimit) || 200)));
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

    var count = box.messages.length;
    var scan = Math.min(count, sinceDays ? scanLimit : limit);
    if (scan <= 0) return JSON.stringify([]);
    var range = box.messages.slice(0, scan - 1);
    var rows = [];
    try {
      var ids = range.id();
      var dates = range.dateReceived();
      var senders = range.sender();
      var subjects = range.subject();
      var reads = range.readStatus();
      for (var i = 0; i < ids.length; i++) rows.push({ id: ids[i], date: dates[i], from: senders[i], subject: subjects[i], read: reads[i] });
    } catch (bulkError) {
      var items = range();
      for (var k = 0; k < items.length; k++) {
        var msg = items[k];
        rows.push({ id: msg.id(), date: msg.dateReceived(), from: msg.sender(), subject: msg.subject(), read: msg.readStatus() });
      }
    }
    var cutoff = sinceDays ? Date.now() - sinceDays * 864e5 : null;
    var out = [];
    for (var j = 0; j < rows.length; j++) {
      var r = rows[j];
      var t = r.date && typeof r.date.getTime === 'function' ? r.date.getTime() : NaN;
      if (cutoff !== null && !(t >= cutoff)) continue;
      out.push({ id: String(r.id), account: account, mailbox: mailboxName, from: text(r.from), subject: text(r.subject), date: iso(r.date), read: r.read === true });
    }
    out.sort(function (a, b) { return String(b.date).localeCompare(String(a.date)); });
    return JSON.stringify(out.slice(0, limit));
  } catch (error) {
    return fail(error);
  }
}

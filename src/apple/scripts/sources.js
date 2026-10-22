// Leash: the accounts, mailboxes, calendars and lists the viewer offers when creating a grant.
// Arg: {}
// Prints: {mail: [{account, mailboxes: [names]}], calendars: [names], lists: [names], errors: [{app, message}]}
// Names only. Never iterates events, messages or reminders (big synced stores cost seconds each).

function run(argv) {
  try { JSON.parse(argv[0] || '{}'); } catch (e) { /* no args needed */ }
  var out = { mail: [], calendars: [], lists: [], errors: [] };
  function note(app, error) { out.errors.push({ app: app, message: String((error && error.message) || error) }); }
  function names(v) { var a = []; if (!v) return a; for (var i = 0; i < v.length; i++) a.push(String(v[i])); return a; }

  try {
    var Mail = Application('Mail');
    var accounts = Mail.accounts();
    for (var i = 0; i < accounts.length; i++) {
      var acct = accounts[i];
      var entry = { account: String(acct.name()), mailboxes: [] };
      try { entry.mailboxes = names(acct.mailboxes.name()); } catch (e) { note('Mail', e); }
      out.mail.push(entry);
    }
  } catch (e) { out.mail = []; note('Mail', e); }

  try { out.calendars = names(Application('Calendar').calendars.name()); } catch (e) { out.calendars = []; note('Calendar', e); }
  try { out.lists = names(Application('Reminders').lists.name()); } catch (e) { out.lists = []; note('Reminders', e); }

  return JSON.stringify(out);
}

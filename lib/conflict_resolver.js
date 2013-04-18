PouchDB.ConflictResolver = SC.Object.extend({
  database: null,
  interval: 30000,
  conflictsView: 'views/conflicts',
  _db: null,

  awake: function() {
    var that = this,
        local = this.get('database');
    Pouch(local, function(err, db) {
      that._db = db;
      SC.Timer.schedule({
        target: that,
        action: "doConflictsPass",
        repeats: YES,
      })
    });
  },

  doConflictsPass: function() {
    var that = this;
    this._db.query(this.get('conflictsView'), function(err, resp) {
      console.log("got conflicts", err, resp);
      if (err) return;
      resp.rows.forEach(function(row) {
        that.resolveConflict(row);
      })
    })
  },

  resolveConflict: function(row) {
    // For now, just delete the other candidates
    row.value.forEach(function(rev) {
      this._db.remove({_id: row.id, _rev: rev}, function(err, resp) {
        console.log("deleted %@ @ %@".fmt(row.id, rev), err, resp);
      })
    })
  }


});



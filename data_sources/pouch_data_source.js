sc_require('pouch.alpha.js');

//Pouch.DEBUG = true;

PouchDB.DataSource = SC.DataSource.extend({

  localDatabaseName: 'pouchdb',
  upstreamDatabase: null,

  filter: undefined,

  lastChange: null,
  lastChangeUpstream: null,
  lastChangeDownstream: null,
  replicationOKUpstream: NO,
  replicationOKDownstream: NO,

  _db: null,
  _upstream: null,

  debug: NO,

  awake: function(cb) {
    var local = this.get('localDatabaseName'),
        remote = this.get('upstreamDatabase'),
        filter = this.get('filter')
        that = this;

    sc_super();

    Pouch.DEBUG = this.get('debug');

    Pouch(local, function(err, db) {
      that._db = db;
      that.beginChanges();

      if (cb) cb();

      if (remote) {
        Pouch(remote, function(err, db) {
          that._upstream = db;
          that._startReplication(false);
          that._startReplication(true);
        })
      }
    });
    return this;
  },

  // Starts a complete replication downstream, makes callback when complete.
  awakeInitial: function(callback) {
    var source = this.get('upstreamDatabase'),
        target = this.get('localDatabaseName'),
        that = this;

    Pouch.replicate(source, target, {filter: this.get('filter')}, function(err, resp) {
      if (resp) {
        callback(true);
        return;
      }
      setTimeout(function() {
          that.awakeInitial(callback);
        }, 1000);
    });
  },

  destroy: function(cb) {
    Pouch.destroy(this.get('localDatabaseName'), cb);
  },

  _logChange: function(upstream, docs, source, target) {
    var changeKey = upstream ? 'lastChangeUpstream' : 'lastChangeDownstream',
        okKey = upstream ? 'replicationOKUpstream' : 'replicationOKDownstream';
    //console.log("got change from %@ to %@".fmt(source, target), docs);
    if (docs && docs.length > 0) {
      SC.RunLoop.begin();
      that.set(changeKey, SC.DateTime.create());
      that.set(okKey, YES);
      SC.RunLoop.end();
    }
  },

  _startReplication: function(upstream) {
    var that = this,
        source = upstream ? this._db : this.get('upstreamDatabase'),
        target = upstream ? this.get('upstreamDatabase') : this._db,
        opts = {continuous: true, filter: this.get('filter'), onChange: function(docs) { that._logChange(upstream, docs, source, target) }};
    
    var changeKey = upstream ? 'lastChangeUpstream' : 'lastChangeDownstream',
        okKey = upstream ? 'replicationOKUpstream' : 'replicationOKDownstream';

    console.log('starting replication from %@ to %@'.fmt(source, target), opts);
    that.set(okKey, YES);
    Pouch.replicate(source, target, opts, function(err, change) {
      console.log("got endchange from %@ to %@".fmt(source, target), err, change);
      if (change) {
        SC.RunLoop.begin();
        that.set(changeKey, SC.DateTime.create());
        SC.RunLoop.end();
      }
      if (err) {
        console.log("replication error %@".fmt(upstream ? 'upstream' : 'downstream'), err);
        SC.RunLoop.begin();
        that.set(okKey, NO);
        SC.RunLoop.end();
        setTimeout(function() {
          that._startReplication(upstream);
        }, 5000);
      }
    });
    that.set(okKey, YES);
  },

  beginChanges: function() {
    var that = this;
    //console.log('changes!!!');
    var completefn = function(err, response) {
      console.log("Changes.complete called??", response, err);
      var seq = response.last_seq;
      console.log("beginning updates from " + seq);
      that._db.changes({since: seq, continuous: true, include_docs: true, onChange: function(change) {that.handleChange(change)}});
    };
    this._db.changes({since: 0, continuous: false, complete: completefn});
  },

  handleChange: function(res) {
    var doc = res.doc, that = this;

    if (res.deleted) {
      this.deleteDoc(res);
      return;
    }

    this.set('lastChange', SC.DateTime.create());

    this._db.get(res.id, function(err, doc) {
      if (doc) that.handleDocChange(doc);
    }); 
  },
    
  handleDocChange: function(doc) {
    if (doc.recordType !== undefined ) {
      var rt = doc.recordType;
      var klass = Forms.get(rt.substring(6));

      if (!SC.none(klass)) {
        var key = Forms.store.storeKeyFor(klass, doc._id);
        //console.log(rt);
        var oldHash = Forms.store.readDataHash(key),
            status = Forms.store.readStatus(key);


        //console.log("updating datahash:", status);
        //console.log(oldHash);
        //console.log(doc);
        if (status != SC.Record.EMPTY && !(status & SC.Record.CLEAN)) {
          // Record is being edited locally.
          // Give up for now, and let the local edits overwrite the foreign
          // edits when we try to save.
          // Having a conflict resolver would help here...
          //console.log("Isn't clean, aborting", status)
          return;
        }
        if (SC.none(oldHash) || doc._rev !== oldHash._rev)
          SC.RunLoop.begin();
          Forms.store.pushRetrieve(klass, doc._id, doc);
          Forms.store.refreshRecord(null, null, key);
          SC.RunLoop.end();
      }
    }
  },

  deleteDoc: function(data) {
    var id = data.id, q, results, obj, storeKey;
    q = SC.Query.create({
      conditions: "id={id}",
      parameters: {id: id},
      localOnly: YES,
    });
    results = Forms.store.find(q);
    obj = results.firstObject();
    if (obj) {
      storeKey = obj.get('storeKey');
      //console.log("Deleting " + obj.toString());
      Forms.store.pushDestroy(null, null, storeKey);
    } else {
      //console.log("Couldn't find object to delete for %@".fmt(id))
    }
  },

  fetch: function(store, query) {
    var rts, that = this;

    if (!this._db || !this._db.query) {
      console.log('db not ready, delaying for %@'.fmt(query))
      setTimeout(function() {
        that.fetch(store, query);
      }, 500);
      return;
    }

    //console.log(query)
    // Do some sanity checking first to make sure everything is in order.
    if (!SC.instanceOf(query, SC.Query)) {
      SC.Logger.error('SCUDS.CouchDBDataSource.fetch(): Error retrieving records: Invalid query.');
      return NO;
    }

    if (query.get('localOnly') || SC.none(query.get('view'))) {
      //console.log("Query is local only, skipping", query.get('conditions'));
      return NO;
    }

    // look at the query for all the different record types that are in this query
    // because we will have to break them up into individual batches and sync them up
    // at the end.
    rts = query.get('expandedRecordTypes') || {};

    // Set a few important attributes on the query.
    query.numRecordTypes = rts.get('length')*1; // <= this is the target number of recordTypes to fetch from the backend
    query.numRecordTypesHandled = 0;
    query.recordHashes = {};
    query.needsRefresh = NO;

    // Iterate through each of the record types in the query (there will usually only be one).
    rts.forEach(function(recordType) {
      that._fetchRecordType(recordType, store, query);
    });

    return YES; // Not required, but good form.
  },

  _fetchRecordType: function(recordType, store, query) {
    var s  = this.get('server'), params,
        db = recordType.prototype.recordDatabase || this.get('database') || 'unknown-database',
        docName = recordType ? recordType.prototype.designDocument || 'views' : 'data';
    if (SC.typeOf(recordType) !== SC.T_CLASS) {
      SC.Logger.error('SCUDS.CouchDBDataSource._fetchRecordType(): Error retrieving records from data source: Invalid record type.');
      return;
    }

    // create params...
    params = {store: store, query: query, recordType: recordType};
    // TODO: [EG] check to see if we need to make a specific view call
    this._fetchRecordsCall(db, docName, params);

    return YES;
  },

  _fetchRecordsCall: function(database, docName, params){
    var rt = params.recordType, q = params.query, recView, that = this;

    //console.log(rt.toString(), q.view);

    // find the correct view
    if(q) recView = q.view;
    if(SC.none(recView) && rt) recView = rt.prototype.allView || 'all_records';

    if (recView === 'all_families') {
      throw "Unknown query";
    }

    this._db.query('%@/%@'.fmt(q.designDocument || 'views', recView), {reduce: false, startkey: q.get('startkey'), endkey: q.get('endkey'), key: q.get('key')}, function(err, response) {
      var obj = PouchDB.DataSource.createResponseObject(err, response);
      SC.RunLoop.begin();
      that._dataFetchComplete(obj, params);
      SC.RunLoop.end();
    });
  },

  _dataFetchComplete: function(response, params) {
    var store = params.store,
        query = params.query, ret,
        recordType = params.recordType;

    query.numRecordTypesHandled++;

    if (SC.$ok(response)) {

      // TODO: [EG] loop through the data
      ret = this._parseCouchViewResponse(recordType, response.get('body'));
      //console.log("loading %@".fmt(recordType));
      //console.log(ret);
      store.loadRecords(recordType, ret);

      if(query.numRecordTypesHandled >= query.numRecordTypes){

        delete query.numRecordTypes;
        delete query.numRecordTypesHandled;
        delete query.recordHashes;
        delete query.needsRefresh;

        store.dataSourceDidFetchQuery(query);
        if (query.successfulCallback) query.successfulCallback();
      }

    // handle error case
    } else {
      store.dataSourceDidErrorQuery(query, response);
      if (query.failureCallback) query.failureCallback(response);
    }
  },

  /**************************************************
  *
  * CODE FOR RETRIEVING A SINGLE RECORD
  *
  ***************************************************/
  retrieveRecord: function(store, storeKey, id) {
    // debugger;
    // map storeKey back to record type
    var recordType = SC.Store.recordTypeFor(storeKey),
        db = recordType.prototype.recordDatabase || this.get('database') || 'data',
        url, params, rev;

    // Get the id
    id = id || store.idFor(storeKey);

    this._db.get(id, function(err, doc) {
      if (err) {
        store.dataSourceDidError(storeKey, SC.Error.create(err));
      } else {
        store.dataSourceDidComplete(storeKey, doc);
      }
    });

    return YES;
  },

  /**************************************************
  *
  * CODE FOR CREATING A SINGLE RECORD
  *
  ***************************************************/
  createRecord: function(store, storeKey, params) {
    // debugger;
    // map storeKey back to record type
    var recordType = SC.Store.recordTypeFor(storeKey),
        db = recordType.prototype.recordDatabase || this.get('database') || 'data',
        url, hash, pk = recordType.prototype.primaryKey;

    if (recordType.isNestedRecord) {
      store.dataSourceDidComplete(storeKey);
      return YES;
    }

    // decide on the URL based on the record type
    hash = store.readDataHash(storeKey) || {};
    hash._id = hash[pk];
    hash.recordType = recordType.toString();
    // if no url is found, we don't know how to handle this record

    params = params || {};
    params.store = store;
    params.storeKey = storeKey;
    params.recordType = recordType;
    params.dataType = 'Create';

    // If the record already has _id, need to PUT it instead of POST
    if (SC.none(hash._id)) {
      this._db.post(hash, function(err, response) {
        that._didUpdateRecord(PouchDB.DataSource.createResponseObject(err, response), params);
      });
    } else {
      this._db.put(hash, function(err, response) {
        that._didUpdateRecord(PouchDB.DataSource.createResponseObject(err, response), params);
      });
    }

    return YES;
  },

  /**************************************************
  *
  * CODE FOR UPDATING A SINGLE RECORD
  *
  ***************************************************/
  updateRecord: function(store, storeKey, params) {
    // debugger;
    // map storeKey back to record type
    var recordType = SC.Store.recordTypeFor(storeKey),
        db = recordType.prototype.recordDatabase || this.get('database') || 'data',
        url, hash, id, that = this;

    if (recordType.isNestedRecord) return NO;

    // decide on the URL based on the record type
    id = store.idFor(storeKey);
    hash = store.readDataHash(storeKey);
    hash._id = id;

    params = params || {};
    params.store = store;
    params.storeKey = storeKey;
    params.recordType = recordType;
    params.dataType = 'Update';

    this._db.put(hash, function(err, response) {
      that._didUpdateRecord(PouchDB.DataSource.createResponseObject(err, response), params);
    });

    return YES;
  },

  /**************************************************
  *
  * CODE FOR DELETING A SINGLE RECORD
  *
  ***************************************************/
  destroyRecord: function(store, storeKey, params) {
    // debugger;
    // map storeKey back to record type
    var recordType = SC.Store.recordTypeFor(storeKey),
        db = recordType.prototype.recordDatabase || this.get('database') || 'data',
        url, hash = store.readDataHash(storeKey), id;

    if (recordType.isNestedRecord) return NO;

    // decide on the URL based on the record type
    params = params || {};
    params.store = store;
    params.storeKey = storeKey;
    params.recordType = recordType;
    params.dataType = 'Delete';

    this._db.remove(hash, function(err, response) {
      that._didDeleteRecord(PouchDB.DataSource.createResponseObject(err, response), params);
    });

    return YES;
  },

  _didDeleteRecord: function(response, params) {
    var store = params.store,
        storeKey = params.storeKey;

    // normal: load into store...response == dataHash
    if (SC.$ok(response)) {
      store.dataSourceDidDestroy(storeKey);

    // error: indicate as such...response == error
    } else {
      store.dataSourceDidError(storeKey, response);
    }

  },

  /**************************************************
  *
  * CALLBACKS
  *
  ***************************************************/
  successfulFetch: function(storeKeys, params, code){
    // CODE for success
  },

  successfulCreate: function(storeKey, params, code){
    // CODE for success
  },

  successfulUpdate: function(storeKey, params, code){
    // CODE for success
  },

  successfulDelete: function(storeKey, params, code){
    // CODE for success
  },

  failureFetch: function(storeKeys, params, code){
    // CODE FOR Failure
  },

  failureCreate: function(storeKey, params, code){
    // CODE for success
  },

  failureUpdate: function(storeKey, params, code){
    // CODE for success
  },

  failureDelete: function(storeKey, params, code){
    // CODE for success
  },


  /**************************************************
  *
  * UTILITY METHODS
  *
  ***************************************************/
  _wasSuccessfulRecordTransaction: function(response, params) {
    var store = params.store, rt = params.recordType,
        storeKey = params.storeKey, hash, callback = 'defaultCallback',
        pk = rt ? rt.prototype.primaryKey || '_id' : '_id';

    // normal: load into store...response == dataHash

    if (SC.$ok(response)) {
      var localDoc = store.readDataHash(storeKey);
      hash = response.get('body') || {};
      console.log("response");
      console.log(hash);

      for(var n in hash)

      hash[pk] = hash._id;
      SC.Store.replaceIdFor(storeKey, hash._id);
      store.dataSourceDidComplete(storeKey, hash);
      callback = 'successful'+params.dataType;
    // error: indicate as such...response == error
    } else {
      console.log(response);
      callback = 'failure'+params.dataType;
      store.dataSourceDidError(storeKey, response);
    }
    // Do the callback
    if (this[callback]) this[callback](storeKey, params, response.status)
  },

  _didUpdateRecord: function(response, params) {
    var store = params.store, rt = params.recordType,
        storeKey = params.storeKey, hash, callback = 'defaultCallback',
        pk = rt ? rt.prototype.primaryKey || '_id' : '_id';

    // normal: load into store...response == dataHash

    if (SC.$ok(response)) {
      var localDoc = store.readDataHash(storeKey);
      hash = response.get('body') || {};

      localDoc._rev = hash.rev
      SC.Store.replaceIdFor(storeKey, hash.id);

      store.dataSourceDidComplete(storeKey, localDoc);
      callback = 'successful'+params.dataType;
    // error: indicate as such...response == error
    } else {
      console.log(response);
      if (response.get('status') == 409) {
        // Got a conflict.  For now, retrieve the latest revision and overwrite the DB with our local copy
        var id = store.idFor(storeKey),
            that = this;
        this._db.get(id, function(err, resp) {
          if (err) {
            store.dataSourceDidError(storeKey, err);
            return;
          }
          var localDoc = store.readDataHash(storeKey);
          localDoc._rev = resp._rev;
          that.updateRecord(store, storeKey, params);
        })
      } else {
        callback = 'failure'+params.dataType;
        store.dataSourceDidError(storeKey, response);
      }
    }
    // Do the callback
    if (this[callback]) this[callback](storeKey, params, response.status)
  },

  // Parse data from the CouchDB server in a more manageable form
  _parseCouchViewResponse: function(recordType, body){
    if (SC.none(body)) return [];
    var ret = [], rows = body.rows || [],
        pk = recordType ? recordType.prototype.primaryKey || '_id' : '_id';

    // loop and strip
    rows.forEach( function(row){
      row.value[pk] = row.value._id;
      ret.push(row.value);
    });

    return ret;
  }
});

PouchDB.DataSource.createResponseObject = function(err, response) {
  //console.log(err, response);
  if (err) {
    return SC.Error.create(err);
  } else {
    return SC.Object.create({
      body: response,
    })
  }
}

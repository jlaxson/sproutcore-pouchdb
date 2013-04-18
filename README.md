Sproutcore-PouchDB
==================

This is a library to integrate Sproutcore's Datastore framework with PouchDB.  PouchDB is an implementation of the CouchDB API, including replication, that runs entirely in javascript, and uses HTML5 local storage, either IndexedDB or WebSQL, as its persistence.  By using PouchDB as your datasource, a sproutcore application can exist entirely ignorant of whether it is on or offline, and Pouch will automatically sync with a CouchDB instance whenever you specify.

Implementation Notes
--------------------

This is very much a pre-alpha product, spun off from a parent Sproutcore app.  It is undocumented, still has ugly, verbose console logging, and at least one significant bug, and PouchDB itself, which is vendored here, is only in an alpha stage itself.

The compiled version of PouchDB here is slightly modified from the main fork, as there are a few ugly things that break when it and Sproutcore meet.

Known Issues
------------

* This adapter attempts to ensure that Pouch<->Couch replication never ceases, by attempting to restart replication whenever Pouch calls back with an error.  Occasionally this restart process will spawn two replication attempts instead of just replacing the one that died, and this will eventually snowball (overnight or more) into a hung browser process, especially if the replication fails often (as happens regularly when using sproutcore's build server).  I am not yet sure if this is a PouchDB bug or lies in this code.
* In your Sproutcore Buildfile, you should increase the proxy timeout so that there aren't chronic issues with PouchDB's use of long polling.  For example: ```ruby proxy '/', :to => 'localhost:5984', :timeout => 30000```

Documentation
-------------

Not yet, sorry.

See Also
--------
* [PouchDB](http://github.com/daleharvey/pouchdb)
* [Sproutcore](http://github.com/sproutcore/sproutcore)
* [CouchDB](http://couchdb.apache.org)
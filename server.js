
"use strict";

var path = require("path");
var ht = require("hudson-taylor");
var mongodb = require("mongodb");
var mailer = require("./lib/service");

var config = require(path.join(__dirname, 'config', process.env.NODE_ENV));
mongodb.MongoClient.connect(config['ht-mailer'].mongoURI, setup);

function setup(err, db) {
    if(err) throw err;
    var transport = new ht.Transports.HTTP({ port: config['ht-mailer'].port });

    var service = mailer.setup(transport, config, db);

    service.listen(function() {
      console.log("ht-mailer running on port", config['ht-mailer'].port);
    });
}

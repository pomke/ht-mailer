var path = require("path");
var ht = require("hudson-taylor");
var mongodb = require("mongodb");
var mailer = require("./lib/service");

var config = require(path.join(__dirname, 'config', process.env.NODE_ENV));
mongodb.MongoClient.connect(config['ht-mailer'].mongoURI, setup);

function setup(err, db) {
    if(err) throw err;
    var server = new ht.Server();
    server.add("mail", mailer.setup, config, db);
    server.listenHTTP({port : config['ht-mailer'].port});
    console.log("ht-mailer running on port", config['ht-mailer'].port);
}

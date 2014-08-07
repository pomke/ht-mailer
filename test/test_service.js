var assert    = require('assert');
var mongodb   = require('mongodb');
var ht = require('hudson-taylor');
var service = require('../lib/service');

describe("ht-mailer", function() {

    var db, client;

    before(function(done){
        var config = require('../config/test');
        mongodb.MongoClient.connect(config['ht-mailer'].mongoURI,
            function(err, database) {
                if(err) throw err;
                db = database;
                client = new ht.Services();
                client.connect("mail", 
                    new ht.LocalClient("mail", service.setup, config, db));
                done();
            });
    });

    after(function(done){
            db.dropDatabase(done);
    });

    it("should queue and send a message", function(done) {
        var testEmail = {
            to : ['mel@example.com'],
            from : 'bev@example.com',
            subject : 'Test email {{number}}',
            template : 'test1',
            data : {number : 123, date : new Date(), name : 'Melanie'}
        }
        client.remote('mail', 'queue', testEmail, function(err, res) {
            console.log('>>>>', typeof err.error, res);
            if(err) throw err;
            console.log(res);
            done();
        });
    });


});


var assert    = require('assert');
var mongodb   = require('mongodb');
var ht = require('hudson-taylor');
var service = require('../lib/service');

describe("ht-mailer", function() {

    var db, client, testBucket = [];

    before(function(done){
        var config = require('../config/test');
        mongodb.MongoClient.connect(config['ht-mailer'].mongoURI,
            function(err, database) {
                if(err) throw err;
                db = database;
                client = new ht.Services();
                client.connect("mail", 
                    new ht.LocalClient("mail", service.setup, config, db, testBucket));
                done();
            });
    });

    after(function(done){
            db.dropDatabase(done);
    });

    it("should queue emails to send", function(done) {
        var testEmail = {
            to : ['mel@example.com'],
            from : 'bev@example.com',
            subject : 'Test email {{number}}',
            text : 'Heya {{name}}, can we meet up at {{date}}?',
            data : {number : 123, date : new Date(), name : 'Melanie'}
        }
        client.remote('mail', 'queue', testEmail, function(err, res) {
            if(err) throw err;
            assert.equal(res[0].subject, 'Test email 123');
            done();
        });
    });

    it("should directly send emails", function(done) {
        var testEmail = {
            to : ['mel@example.com'],
            from : 'bev@example.com',
            subject : 'Test email {{number}}',
            text : 'Heya {{name}}, can we meet up at {{date}}?',
            data : {number : 123, date : new Date(), name : 'Melanie'}
        }
        client.remote('mail', 'send', testEmail, function(err, res) {
            if(err) throw err;
            checkBucket(3, function(info) {
                assert.equal(info.envelope.from, 'bev@example.com');
                done();
            });
        });
    });


    it("should load a template email", function(done) {
        var testEmail = {
            to : ['mel@example.com'],
            from : 'bev@example.com',
            subject : 'Test email {{number}}',
            template : 'test1',
            data : {number : 123, date : new Date(), name : 'Melanie'}
        }
        client.remote('mail', 'queue', testEmail, function(err, res) {
            if(err) throw err;
            assert.equal(res[0].subject, 'Test email 123');
            done();
        });
    });

    it("should deliver queued email", function(done) {
        var testEmail = {
            to : ['mel@example.com'],
            from : 'bev@example.com',
            subject : 'Test email {{number}}',
            template : 'test1',
            data : {number : 123, date : new Date(), name : 'Melanie'}
        }
        client.remote('mail', 'queue', testEmail, function(err, res) {
            if(err) throw err;
            checkBucket(2, function(info) {
                assert.equal(info.envelope.from, 'bev@example.com');
                done();
            });
        });
    });

    it("should not deliver mail to a blacklisted account", function(done) {
        var testEmail = {
            to : ['mel@example.com'],
            from : 'bev@example.com',
            subject : 'Test email {{number}}',
            template : 'test1',
            data : {number : 123, date : new Date(), name : 'Melanie'}
        }

        client.remote('mail', 'blockEmail', {email : 'mel@example.com'}, function(err, res) {
            if(err) throw err;
            assert.equal(res.blocked, true);
            done();
        });
    });



    function checkBucket(index, callback) {
        if(testBucket[index])  return callback(testBucket[index]);
        setTimeout(function(){checkBucket(index, callback);}, 200);
    }

});


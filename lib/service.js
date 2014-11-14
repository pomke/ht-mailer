var fs            = require('fs');
var async         = require('async');
var ht            = require('hudson-taylor');
var handlebars    = require('handlebars');
var attrition     = require('attrition');
var nodemailer    = require('nodemailer');
var smtpTransport = require('nodemailer-smtp-transport');
var sesTransport  = require('nodemailer-ses-transport');
var stubTransport = require('nodemailer-stub-transport');
var markdown      = require('nodemailer-markdown').markdown;

exports.setup = function(s, ready, config, db, testBucket) {
    //XXX testBucket is only used by the unitTest code to confirm mail delivery

    config = exports.configSchema.validate(config)['ht-mailer'];
    var subscription = db.collection('ht-mailer-subscription');
    var queue = db.collection('ht-mailer-mailqueue');
    var upsert = {w:1, new:true, upsert: true};


    var sendSchema = s.Object({
        to       : s.Array([s.Email()]),
        cc       : s.Array({opt:true, default : []}, [s.Email()]),
        bcc      : s.Array({opt:true, default : []}, [s.Email()]),
        from     : s.Email(),
        subject  : s.String(),
        template : s.String({opt:true}),
        text     : s.String({opt:true}),
        html     : s.String({opt:true}),
        markdown : s.String({opt:true}),
        data     : s.Object({opt:true, strict : false})
    });


    /* Define the service APIs */

    s.on("queue", sendSchema, enqueue);
    s.on("send", sendSchema, send);
    s.on("blockEmail", s.Object({email : s.Email()}), blockEmail);
    s.on("blockToken", s.Object({token : s.String()}), blockToken);
    s.on("unblockToken", s.Object({token : s.String()}), unblockToken);
    s.on("unblockEmail", s.Object({email : s.Email()}), unblockEmail);

    /* Start processing emails in the queue */
    attrition.start(queue, {}, deliverEmail);
    /* Configure the mail transport */
    var transport;
    switch(config.transport.type) {
        case 'SMTP':
            transport = smtpTransport(config.transport['SMTP-arguments']);
            break;
        case 'SES':
            transport = sesTransport(config.transport['SES-arguments']);
            break;
        case 'STUB':
            transport = stubTransport();
            break;
    }
    var transporter = nodemailer.createTransport(transport);
    transporter.use('compile', markdown());

    function deliverEmail(task, callback) {
        transporter.sendMail(task, function(err, info) {
            if(err) return callback(err);
            if(testBucket) {
                //assume testbucket is an array, add the item to the array,
                testBucket.push(info);
                //then add the item again using the subject as the key.
                if(!testBucket[info.subject]) testBucket[info.subject] = [];
                testBucket[info.subject].push(info);
            }
            callback(null, false); //delivered, remove form the queue
        });
    }

    function blockToken(data, callback) {
        return subscription.findAndModify(
                {_id : data.token}, null, {$set : {blocked : true}},
                {w:1}, callback);
    }

    function unblockToken(data, callback) {
        return subscription.findAndModify(
                {_id : data.token}, null, {$set : {blocked : false}},
                {w:1}, callback);
    }


    function blockEmail(data, callback) {
        return subscription.findAndModify(
                {email : data.email}, null, {$set : {blocked : true}},
                upsert, callback);
    }

    function unblockEmail(data, callback) {
        return subscription.findAndModify(
                {email : data.email}, null, {$set : {blocked : false}},
                upsert, callback);
    }

    function enqueue(data, done) {
        /* This function queues a message up for sending  */
        var begin = function(cb) { return cb(null, data, done); }
        return async.waterfall([
                begin, filterBlacklistedEmails, createSubs, makeTask, finish],
                queueTask);
    }

    function send(data, done) {
        /* This function sends a message directly */
        var begin = function(cb) { return cb(null, data, done); }
        return async.waterfall([
                begin, filterBlacklistedEmails, createSubs, makeTask, finish],
                sendTask);
    }


    // find or create this email in the subscriptions table to get their
    // unsubscribe token and check if they are blocked.
    function filterBlacklistedEmails(data, done, callback) {
        /* Concat to, cc and bcc lists, search for existing subscriptions
         * split into 3 arrays:
         *  - allowed (array of subscriptions),
         *  - blocked (array of subscriptions),
         *  - notFound (array of email addresses not found)
         */
        var emails = data.to.concat(data.cc, data.bcc);
        var notFound = emails.concat([]); //copy
        var allowed = [];

        return subscription.find({ email : { $in : emails }}).toArray(
            function(err, res) {
                if(err) return callback(err);
                var blocked = (res||[]).filter(function(sub) {
                    delete notFound[notFound.indexOf(sub.email)];
                    if(!sub.blocked) allowed.push(sub);
                    return sub.blocked;
                });

                return callback(null, data, done, allowed, blocked,
                    notFound.filter(function(x){return x}));
            });
    };

    function createSubs(data, done, allowed, blocked, notFound, callback) {
        /* Create subscriptions for any notFound emails and add them
         * to the allowed list.
         */
        var inserts = notFound.map(function(e){return {email:e};});
        if(inserts.length > 0) {
            return subscription.insert(inserts, {w:1},
                    function(err, results) {
                        if(err) {
                            return callback(new Error("could not create subs" + err));
                        }
                        return callback(null, data, done, allowed.concat(results), blocked);
                    });
        } else {
            return callback(null, data, done, allowed, blocked);
        }
    }


    function makeTask(data, done, allowed, blocked, callback) {
        /* Create a task and queue it for sending an email */
        var task = {}; // This is the task that will get queued.

        //filter out blocked users
        task.to = filter(data.to, blocked);
        task.cc = filter(data.cc, blocked);
        task.bcc = filter(data.bcc, blocked);

        if(task.to.length==0 && task.cc.length==0 && task.bcc.length==0) {
            //We no longer have anyone to send an email to, return
            return done(null, []);
        }

        //Find out which email template we're using
        if(data.template) {
            //Using a file-based template, find it in config.templates.
            var tpl = config.templates[data.template];
            if(!tpl) return done({err: "No template '"+data.template+"' registered in ht-mailer config"});
            var toLoad = []; //templates that need loading
            if(tpl.markdown) toLoad.push(['markdown', tpl.markdown]);
            if(!tpl.markdown && tpl.html) toLoad.push(['html', tpl.html]);
            if(!tpl.markdown && tpl.text) toLoad.push(['text', tpl.text]);

            async.map(toLoad, function(item, cb) {
                fs.readFile(item[1],{encoding:'utf8'}, function(err, file) {
                    if(err) return cb(err);
                    return cb(null, [item[0], file]);
                });
            }, function(err, templates) {
                if(err) return done(err);
                //We have our templates loaded, call finish
                return callback(null, data, done, task, templates, allowed);
            });

        } else {
            var templates = [];
            if(data.markdown) templates.push(['markdown', data.markdown]);
            if(!data.markdown && data.html) templates.push(['html', data.html]);
            if(!data.markdown && data.text) templates.push(['text', data.text]);
            if(templates.length == 0) {
                //we have been provided no way to make a msg body, abort.
                return done({err : "no message body found"});
            }
            //We have our templates, call finish
            return callback(null, data, done, task, templates, allowed);
        }
    }

    function finish(data, done, task, templates, allowed, callback) {
        // Populate our template with data
        var extras = {};
        if(task.to[0]) {
            // find the first 'to' recipient to provide the unsub token
            allowed.every(function(sub) {
                if(sub.email == task.to[0]) {
                    extras.unsubscribeToken = sub._id;
                    return false;
                }
                return true;
            });
        }
        var values = ht.utils.merge(data.data, extras);
        // render templates and add to the task
        templates.forEach(function(t) {
            task[t[0]] = bakeTemplate(t[1], values);
        });

        //finish populating the task
        task.to = task.to.join(', ');
        task.cc = task.cc.join(', ');
        task.bcc = task.bcc.join(', ');
        task.from = data.from;
        task.subject = bakeTemplate(data.subject, values);

        return callback(null, task, done);
    }

    function queueTask(err, task, done) {
        if(err) return done(err);
        return attrition.queue(queue, task, done);
    }

    function sendTask(err, task, done) {
        if(err) return done(err);
        return deliverEmail(task, done);
    }
};

/******************************** Config Schema *******************************/
var s = ht.validators;
exports.htConfigSchema = s.Object({strict : false}, {
    mongoURI : s.String({opt:true}), // Only if using server.js
    port : s.Number({opt:true}), // Only if using server.js
    templates : s.Object({opt:true, strict:false}, {
        "*" : s.Object({
                markdown : s.String({opt:true}),
                html : s.String({opt:true}),
                text : s.String({opt:true})
        })
    }),
    transport : s.Object({
        type : s.String({enum : ['SES', 'SMTP', 'STUB']}),

        'SES-arguments' : s.Object({opt:true, strict:false}, {
            accessKeyID : s.String({opt : true}),
            secretAccessKey : s.String({opt : true}),
            sessionToken : s.String({opt : true}),
        }),

        'SMTP-arguments' : s.Object({opt:true, strict:false})
    })
});

exports.configSchema = s.Object({strict : false}, {
    'ht-mailer' :  exports.htConfigSchema
});


/********************************** Helpers ***********************************/

function filter(emails, blocked) {
    /* Takes array of email addresses, and array of blocked subs,
     * and returns a filtered emails list.
     */
    return emails.filter(function(e) {
        return blocked.every(function(sub) {return e != sub.email;});
    });
}

function bakeTemplate(template, data) {
    /* Process a handlebars template and data */
    return handlebars.compile(template)(data);
}





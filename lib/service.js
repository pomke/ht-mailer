var fs          = require('fs');
var async       = require('async');
var ht          = require('hudson-taylor');
var handlebars  = require('handlebars');
var attrition   = require('attrition');

exports.setup = function(s, ready, config, db) {

    // Object Schema for configuration data
    var configSchema = s.Object({strict : false}, {
        'ht-mailer' : s.Object({strict : false}, {
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

                'SES-arguments' : s.Object({opt:true}, {
                    accessKeyID : s.String({opt : true}),
                    secretAccessKey : s.String({opt : true}),
                    sessionToken : s.String({opt : true}),
                    region : s.String({opt : true}),
                    rateLimit : s.Number({opt : true})
                }),

                'SMTP-arguments' : s.Object({opt:true}, {
                    port : s.Number({opt:true}),
                    host : s.String({opt:true}),
                    secure : s.Boolean({opt:true}),
                    ignoreTLS : s.Boolean({opt:true}),
                    name : s.String({opt:true}),
                    localAddress : s.String({opt:true}),
                    connectionTimeout : s.Number({opt:true}),
                    greetingTimeout : s.Number({opt:true}),
                    socketTimeout : s.Number({opt:true}),
                    debit : s.Boolean({opt:true}),
                    authMethod : s.String({opt:true}),
                    tls : s.Object({opt:true, strict:false}),
                    auth : s.Object({opt:true}, {
                        user : s.String({opt:true}),
                        pass : s.String({opt:true}),
                        xoauth2 : s.String({opt:true})
                    })
                })
            })
        })
    });

    config = configSchema.validate(config)['ht-mailer'];
    var subscription = db.collection('ht-mailer-subscription');
    var queue = db.collection('ht-mailer-mailqueue');
    var upsert = {w:1, new:true, upsert: true};


    var sendSchema = s.Object({
        to       : s.Array([s.Email()]),
        cc       : s.Array({opt:true}, [s.Email()]),
        bcc      : s.Array({opt:true}, [s.Email()]),
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
    s.on("blockEmail", s.Object({email : s.Email()}), blockEmail);
    s.on("blockToken", s.Object({token : s.String()}), blockToken);
    s.on("unblockEmail", s.Object({email : s.Email()}), unblockEmail);

    /* Start processing emails in the queue */
    attrition.start(queue, {}, deliverEmail, 30*1000);

    function deliverEmail(task, callback) {
        console.log('SENDING', task);
        callback(null, true);
    }

    function blockToken(data, callback) {
        return subscription.findAndModify(
                {_id : data.token}, null, {$set : {block : true}},
                {w:1}, callback);
    }

    function blockEmail(data, callback) {
        return subscription.findAndModify(
                {email : data.email}, null, {$set : {block : true}},
                upsert, callback);
    }

    function unblockEmail(data, callback) {
        return subscription.findAndModify(
                {email : data.email}, null, {$set : {block : false}},
                upsert, callback);
    }

    function enqueue(data, callback) {
        /* This function queues a message up for sending  */

        // find or create this email in the subscriptions table to get their
        // unsubscribe token and check if they are blocked.
        return async.waterfall([filterBlacklistedEmails, createSubs], _queue);

        function filterBlacklistedEmails(callback) {
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

                    return callback(null, allowed, blocked,
                        notFound.filter(function(x){return x}));
                });
        };

        function createSubs(allowed, blocked, notFound, callback) {
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
                            return callback(allowed.concat(results), blocked);
                        });
            } else {
                return callback(allowed, blocked);
            }
        }


        function _queue(err, allowed, blocked) {
            console.log("Q", err, allowed, blocked);
            /* Create a task and queue it for sending an email */
            if(err) {
                console.log("ERR", err);
                return callback(err);
            }
            var task = {}; // This is the task that will get queued.

            //filter out blocked users
            task.to = filter(data.to, blocked);
            task.cc = filter(data.cc, blocked);
            task.bcc = filter(data.bcc, blocked);

            if(task.to.length==0 && task.cc.length==0 && task.bcc.length==0) {
                //We no longer have anyone to send an email to, return
                return callback(null);
            }

            //Find out which email template we're using
            if(email.template) {
                //Using a file-based template, find it in config.templates.
                var tpl = config.templates[email.template];
                if(!tpl) return callback({err: "No template '"+email.template+"' registered in ht-mailer config"});
                var toLoad = []; //templates that need loading
                if(tpl.markdown) toLoad.push(['markdown', tpl.markdown]);
                if(!tpl.markdown && tpl.html) toLoad.push(['html', tpl.html]);
                if(!tml.markdown && tpl.text) toLoad.push(['text', tpl.text]);

                async.map(toLoad, function(item, done) {
                    fs.readFile(item[1], function(err, file) {
                        if(err) return done(err);
                        return done(null, [item[0], file]);
                    });
                }, function(err, templates) {
                    if(err) return callback(err);
                    //We have our templates loaded, call finish
                    return finish(task, data, templates, allowed, callback);
                });

            } else {
                var templates = [];
                if(email.markdown) templates.push(['markdown', email.markdown]);
                if(!email.markdown && email.html) templates.push(['html', email.html]);
                if(!email.markdown && email.text) templates.push(['text', email.text]);
                if(templates.length == 0) {
                    //we have been provided no way to make a msg body, abort.
                    return callback({err : "no message body found"});
                }
                //We have our templates, call finish
                return finish(task, data, [['markdown', email.markdown]], allowed, callback);
            }
        }

        function finish(task, data, templates, allowed, callback) {
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
            var values = ht.util.merge(data.data, extra);
            // render templates and add to the task
            templates.forEach(function(t) {
                task[t[0]] = bakeTemplate(t[1], values);
            });

            //finish populating the task
            task.from = data.from;
            task.subject = bakeTemplate(data.subject, values);

            //Queue the task
            return attrition.queue(queue, task, callback);

        }
    }



};

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





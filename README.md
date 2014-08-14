#ht-mailer 

ht-mailer is a [hudson-taylor](https://www.npmjs.org/package/hudson-taylor) 
service for sending email, you can run it as a stand-alone service or use it 
in-process via the hudson-taylor LocalClient connector.

### Key features

 * ht-mailer uses nodemailer, and can communicate with any nodemailer tranport,
   ie: AWS Simple Message Service, SMTP server, etc.

 * ht-mailer manages an email blacklist, and provides easy to use APIs for 
   managing your blacklist (think unsubscribe tokens, etc). 

 * ht-mailer keeps a message queue, and will retry emails if the transport is
   currently unavailable.

 * ht-mailer can be configured with mail templates (using [handlebars](https://www.npmjs.org/package/handlebars)
   notation), either plain text, html or markdown (generates both plain text and html).

 * ht-mailer currently requires a MongoDB DB handle which it uses to store 
   blacklists and message queues. In the future this can be made pluggable.

### Public API

##### queue

Queue an email message to be delivered.

```javascript
s.remote("mailer", "queue", msg, callback);
```

##### send

Skip the queue and send directly

```javascript
s.remote("mailer", "send", msg, callback);
```

##### blockToken

Block an email address that corresponds to token

```javascript
s.remote("mailer", "blockToken", {token : <token>}, callback);
```

##### blockEmail

Block an email address 

```javascript
s.remote("mailer", "blockEmail", {email : <email>}, callback);
```


##### unblockEmail

Unblock an email address 

```javascript
s.remote("mailer", "unblockEmail", {email : <email>}, callback);
```

### Using ht-mailer as a stand-alone service. 

 * copy config/example.json to config/production.json (or development.json etc) and add your config.

```bash 
$> NODE_ENV=production node server.js
```

You can now communicate with it using the hudson-taylor client library, ie:

```javascript
var s = new ht.Services();
s.connect("mail", new ht.HTTPClient("mail", "localhost", 7001));
```

Send a templated message to jemma:

```javascript
var msg = { 
    to : ['jemma@example.com'],
    from : 'mel@example.com',
    subject : 'Example Email {{foo}}',
    data : { foo : 123 },
    template : 'approval' // name of the template to use
}

s.remote("mailer", "queue", msg, function(err, res) { 
    // Do things with the response here! 
});
```

Send a regular text/html email to one person:

```javascript
var msg = { 
    to : ['joe@example.com'],
    from : 'mel@example.com',
    subject : 'Example email to {{name}}',
    data : { name : "Joe" }
    text : "Hi {{name}}!",
    html : "<h1>Hi {{name}}!</h1>"
}

s.remote("mailer", "queue", msg, function(err, res) {
    // do stuff!
});
``` 

### Using ht-mailer as an HT service. 

ht-mailer service setup requires a config object, and a mongodb connection:


```javascript
var mailer = require("ht-mailer");
var server = new require('hudson-taylor').Server();

var config; // See config documentation below
var db; // Set up a mongodb connection here

server.add("mailer", mailer.setup, config, db);

// Start communicating with an ht client/json-rpc
```

### Config options

Config is namespaced under an 'ht-mailer' key to play nicely with other 
services being configured together.

Example setup using SES transport, with some pre-defined templates

```javascript
{ 
    'ht-mailer' : {
        port : 7001,

        tansport : {
            type : 'SES', //or SMTP, etc
            'SES-arguments' : {
                accessKeyID : '123..',
                secretAccessKey : '456..'
            }
        }, 

        templates : {
            'welcome' : {markdown : '/var/myservice/templates/welcome.md'},
            'unsubscribe' : {html : '/var/myservice/templates/unsub.html',
                             text : '/var/myservice/templates/unsub.txt'},
            'textemail' : {text : '/var/myservice/templates/boring.txt'}
        }
            
    }
}
```


### Templates

All tempaltes use [handlebars](https://www.npmjs.org/package/handlebars) 
notation, which will be populated with the data provided to the send API.

Special keys you can use in templates, further to the data the caller provides
are:

* unsubscribeToken  - This token can be passed to the unsubscribe API, which
  will block email being sent to this address in the future. ie:
  ```html
  <a href='http://example.com/unsub/{{unsubscribeToken}}'>Unsubscribe here.</a>
  ```

  Note, when passing multiple email addresses in the 'to' field, the unsubscribe
  token will only apply to the first address in the list. I don't recommend using
  unsubscribeToken in an email with multiple to recipients, it doesn't make much
  sense.

Templates are configured via the tempaltes attribute in the config JSON, and 
can contain a file path for: markdown, text, html. 

If type markdown is provided, it will be used to produce html AND text output.

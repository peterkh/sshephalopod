// Handle a signing requst
// Expected inputs:
// {
//      "SAMLAssertion": "base64-encoded assertion",
//      "SSHPublicKey": "ssh-rsa pubkey",
//      "Username": "destination host username",
//      "Hostname": "destination hostname"
// }
//

// dirty fscking hack

var fs = require('fs');
var xpath = require('xpath'),
    dom = require('xmldom').DOMParser;
var async = require('async');
var SAML = require('passport-saml').SAML;
var spawn = require('child_process').spawn;
var exec = require('child_process').exec;
var temp = require('temp');
var path = require('path');
var AWS = require('aws-sdk');

var DURATION_HOURS = 12;

exports.handler = function(event, context) {
    console.log('Received event:', JSON.stringify(event, null, 2));
    console.log('Context is: %j', context);

    // Need to work out which IDP to pull the metadata for
    var response = new Buffer(event.body.SAMLResponse, 'base64').toString();
    var idpPath = ".//*[local-name()='Issuer']/text()";
    var responsedoc = new dom().parseFromString(response);
    var idp = xpath.select(idpPath, responsedoc)[0].toString();

    var saml_options = {
        issuer: 'urn:rea:sshephalopod',
        validateInResponseTo: false, // turning this on requires an inmemorycache provider
        requestIdExpirationPeriodMs: 3600000,
        cacheProvider: {}, // since we won't be sticking around ...
        privateCert: fs.readFileSync("saml_sp.key").toString(),
        entryPoint: "https://do.not.need.one/",
        callbackUrl: 'https://do.not.need.one/'
    };


    var bucketName = event.KeypairBucket;
    var keyName = event.KeypairName;
    var realName = 'REAL-NAME-HERE';
    var tempdir;
    var db_params = {
        Key: {
            IdpName: 'default'
        },
        TableName: 'IdpMetadataTable'
    };
    var cert = '';
    var returnData = {};

    async.waterfall([
        function createTempFile(next) {
            temp.mkdir('sshephalopod', next);
        }, function writeTempFile(info, next) {
            tempdir = info;
            fs.writeFile(path.join(tempdir, 'pubkey'), event.body.SSHPublicKey, next);
        }, function logTempDir(next) {
            console.log('Created dir ' + tempdir);
            next(null);
        },
        function getIdpData(next) {
            console.log("Getting metadata from ", event.IdpMetadataEndpoint);
            retrieveMetadata(event.IdpMetadataEndpoint, next);
        },
        function assignCert(data, next) {
            var doc = new dom().parseFromString(data);
            var path = ".//*[local-name()='X509Certificate']/text()";
            saml_options.cert = xpath.select(path, doc)[0].toString('utf8');
            console.log('i has a cert: %j', saml_options.cert);
            next(null);
        }, function AssertResponse(next) {
            var saml = new SAML(saml_options);

            console.log("Going to try and assert a response: %j", saml_options);

            var xml = new Buffer(event.body.SAMLResponse, 'base64').toString('utf8');
            var doc = new dom().parseFromString(xml);
            var path = ".//*[local-name()='Response' and " +
                       "namespace-uri() = 'urn:oasis:names:tc:SAML:2.0:protocol']";
            var saml2_response = xpath.select(path, doc).toString();
            console.log('using saml2_response: %j', saml2_response);

            console.log("Retrieving real name from XML");
            path = ".//*[local-name()='Attribute' and @Name='email']/*[local-name()='AttributeValue']/text()";
            realName = xpath.select(path, doc).toString();
            console.log("Got realName of " + realName);
            var encoded_response = new Buffer(saml2_response).toString('base64');
            var response = {
                SAMLResponse: encoded_response
            };
            saml.validatePostResponse(response, next);
        },
        function handlePostAssert(profile, loggedOut, next) {
            console.log("handPostAssert(%j, %j)", profile, loggedOut);
            now = new Date();
            expiry = new Date(now.setHours(now.getHours() + DURATION_HOURS));
            if (loggedOut) {
                var err = new Error("User has been logged out")
                next(err);
            } else {
                returnData = {
                    Result: true,
                    Message: "Authentication succeeded",
                    Expiry: expiry.toISOString()
                };
                next(null)
            }
        },
        function getKey(next) {
            retrieveKey(bucketName, keyName, next);
        },
        function saveKey(privKey, next) {
            console.log("Saving key to local filesystem");
            fs.writeFileSync(path.join(tempdir, keyName), privKey);
            console.log("Protecting mode of key");
            fs.chmod(path.join(tempdir, keyName), 0700, next);
        },
        function makeCopies(next) {
            console.log("Copying in binaries");
            var args = [
                'cp bin/ssh-keygen bin/libfipscheck.so.1 ' + tempdir,
                '&&',
                'chmod 0700 ' + tempdir
            ];
            var copy = exec(args.join(' '), next);
        },
        function copied(stdout, stderr, next) {
            console.log('copied: ' + stdout);
            next(null);
        },
        function signKey(next) {
            var thing = fs.readFileSync(path.join(tempdir, 'pubkey')).toString();
            console.log("SSH key is: " + thing);

            var now = new Date();
            var args = [
                './ssh-keygen',
                '-s', keyName,
                '-V', '+' + DURATION_HOURS + 'h',
                '-z', now.getTime(),
                '-I', realName,
                '-n', event.body.Username,
                '-O', 'no-agent-forwarding',
                '-O', 'no-user-rc',
                'pubkey'
            ];

            process.env.LD_LIBRARY_PATH = tempdir;
            process.env.HOME = tempdir;

            var opts = {
                cwd: tempdir,
                env: process.env
            };
            opts.env.HOME = tempdir;

            console.log('process env is %j', process.env);
            console.log('args for exec are: %j', args);
            console.log('opts for exec are: %j', opts);

            var ssh_keygen = exec(args.join(' '), opts, next);
        }, function spawnedKeyGen(stdout, stderr, next) {
            console.log("should be spawned");
            console.log('ssh_keygen: %s', stdout);
            returnData.SignedKey = fs.readFileSync(path.join(tempdir, "pubkey-cert.pub")).toString('base64');
            next(null);
        }
    ], function(err) {
        // temp.cleanupSync();
        if (err) {
            console.error(err, err.stack);
            context.done(err);
        } else {
            console.log("Received successful response: %j", returnData);
            context.done(null, returnData);
        }
    });

};

function retrieveKey(bucketName, keyName, callback) {
    var s3 = new AWS.S3();
    var privKey = "";

    var privKeyParams = {
        Bucket: bucketName,
        Key: keyName
    };

    async.waterfall([
        function loadPrivateKey(next) {
            console.log("Checking for a private key in S3");
            s3.getObject(privKeyParams, next);
        }, function decidePrivateKey(data, next) {
            console.log("Found private key, re-using");
            privKey = data.Body.toString('utf8').trim();
            next(null);
        }
    ], function (err, result) {
        if (err) {
            console.log("Error checking existing keys");
            console.log(err, err.stack);
            callback(new Error("cannot load keypair"), null);
        } else if (privKey === '') {
            callback(new Error("cannot load keypair"), null);
        } else {
            callback(null, privKey);
        }
    });
}

function retrieveMetadata(IdpURL, callback) {
    console.log('Retrieving metadata from ' + IdpURL);

    var responseData = {};

    if (IdpURL) {
        if (IdpURL.match('https')) {
          https = require('https');
          var url = require('url');
          var parsedUrl = url.parse(IdpURL);
          var options = {
              hostname: parsedUrl.hostname,
              port: 443,
              path: parsedUrl.path,
              method: 'GET'
          };
          var stringResult = '';
          var request = https.request(options, function(response) {
            console.log('Status code: ' + response.statusCode);
            console.log('Status message: ' + response.statusMessage);
            response.on('data', function(data) {
              stringResult += data.toString();
            });
            response.on('end', function() {
                console.log('Got metadata: ' + stringResult);
                callback(null, stringResult);
            });
          });
          request.on('error', function(err) {
            callback({Error: err, Opts: options}, null);
          });
          request.end();
        } else {
          callback({Error: 'IdP URL not supported'}, null);
        }
    } else {
        callback({Error: 'IdP URL not supported'}, null);
    }
};

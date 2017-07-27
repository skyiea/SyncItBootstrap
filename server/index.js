/**
 * Module dependencies.
 */
const express = require('express');
const path = require('path');
const app = express();
const fs = require('fs');
const http = require('http');
const https = require('https');
const mongoskin = require('mongoskin');
const SseCommunication = require('sse-communication/Simple');

const ReferenceServer = require('syncit-server/ReferenceServer');
const ServerPersistMongodb = require('syncit-server/ServerPersist/Mongodb');
const ServerPersistMemoryAsync = require('syncit-server/ServerPersist/MemoryAsync');

const generateNewDatasetName = require('./lib/generateNewDatasetName');
const fixNoFlightCorsRequestBody = require('./lib/fixNoFlightCorsRequestBody');
const generateRandomString = require('./lib/generateRandomString');
const appConfig = require('./config');

const sseCommunication = new SseCommunication();

const syncItServerPersist = (function() {
	if (!parseInt(appConfig.syncit.persist_data, 10)) {
		return new ServerPersistMemoryAsync();
	}

	const {
		host,
		port,
		name,
  	} = appConfig.databases.main;

	const mongoskinConnection = mongoskin.db(
		`mongodb://${host}:${port}/${name}`,
		{
			w: true
		}
	);

	return new ServerPersistMongodb(
		(v) => JSON.parse(JSON.stringify(v)),
		mongoskinConnection,
		mongoskin.ObjectID,
		appConfig.syncit.data_collection,
		function() {}
	);
}());

const setDeviceIdMiddleware = (req, res, next) => {
	req.deviceId = req.params.deviceId;
	next(null);
};

const referenceServer = new ReferenceServer(
	(req) => req.deviceId,
	syncItServerPersist,
	sseCommunication
);

const allowCors = (req, res, next) => {
	res.header('Access-Control-Allow-Origin', '*');
	res.header('Access-Control-Allow-Methods', 'GET,POST');

	if (req.method == 'OPTIONS') {
		return res.send(200);
	}
	next();
};

app.set('port', appConfig.http.port);
app.set('views', path.join(__dirname, '../src/views'));
app.set('view engine', 'jade');
app.use(express.favicon());
app.use(express.logger('dev'));
app.use(express.json());
app.use(express.urlencoded());
app.use(express.methodOverride());
app.use(allowCors);
app.use(app.router);
app.use(express.static(path.join(__dirname, '../public')));

if ('development' == app.get('env')) {
	console.log("DEVELOPMENT MODE");
	app.use(express.errorHandler());
}

let statusCodesObj = (function(data) {
	"use strict";
	let oData = {};
	for (let i=0, l=data.length; i<l; i++) {
		oData[
			data[i].description.toLowerCase().replace(/[^a-z]/,'_')
		] = data[i].status;
	}
	return oData;
}(require('../res/http_status_codes.js')));

let getStatusCode = function(status) {
	if (!statusCodesObj.hasOwnProperty(status)) {
		throw "Could not find status code for status '" + status + "'";
	}
	return statusCodesObj[status];
};

let getQueueitemSequence = (req, res, next) => {
	referenceServer.getQueueitems(
		req,
		function(err, status, data) {
			if (err) { return next(err); }
			res.json(getStatusCode(status), data);
		}
	);
};

app.get('/syncit/sequence/:s/:seqId', getQueueitemSequence);
app.get('/syncit/sequence/:s', getQueueitemSequence);
app.get('/syncit/change/:s/:k/:v', (req, res, next) => {
	referenceServer.getDatasetDatakeyVersion(
		req,
		function(err, status, data) {
			if (err) { return next(err); }
			res.json(getStatusCode(status), data);
		}
	);
});

const getStandardTemplateData = function() {
	return {
		title: 'Express',
		production: app.get('env') === 'production',
		persistData: parseInt(appConfig.syncit.persist_data, 10)
	};
};

app.get('/', (req, res) => {
	res.render('front', getStandardTemplateData());
});

app.get('/list', (req, res) => {
	res.render('list', getStandardTemplateData());
});

app.post('/syncit/:deviceId', fixNoFlightCorsRequestBody, setDeviceIdMiddleware, (req, res, next) => {
	referenceServer.push(req, function(err, status, data) {
		if (err) { return next(err); }
		res.json(getStatusCode(status), data);
	});
});

let isDatasetInvalidOrAlreadyUsed = function(dataset, next) {
	if (dataset.match(/^[0-9]/)) {
		return next(null, true);
	}
	
	syncItServerPersist.getQueueitems(dataset, null, function(err, status, queueitems) {
		if (err) { return next(err); }
		next(null, queueitems.length > 0 ? true : false);
	});
};

app.post('/', (req, res, next) => {
	generateNewDatasetName(
		generateRandomString.bind(this, 12),
		isDatasetInvalidOrAlreadyUsed,
		function(e, listId) {
			if (e) { return next(e); }
			res.redirect('/list#/' + listId);
		}
	);
});

app.get(
	'/sync/:deviceId',
	setDeviceIdMiddleware,
	referenceServer.sync.bind(referenceServer),
	(req, res, next) => {
		referenceServer.getMultiQueueitems(req, function(err, status, data) {
			if (err) { return next(err); }
			if (status !== 'ok') {
				return res.write(SseCommunication.formatMessage(
					'status-information', status
				));
			}
			res.write(SseCommunication.formatMessage('download', data));
		});
	}
);

app.get('/offline.manifest.appcache', (req, res) => {
	if (app.get('env') != 'production') {
		return res.send("CACHE MANIFEST\nNETWORK:\n*");
	}
	
	res.set('Content-Type', 'text/cache-manifest');
	
	let data = [
		'CACHE MANIFEST',
		'# ' + appConfig.syncittodomvc.manifest_version,
		'CACHE:',
		'/',
		'/list',
		'/css/main.css',
		'/css/front.css',
		'/css/list.css',
		'/vendor-bower/todomvc-common/base.css',
		'/vendor-bower/todomvc-common/bg.png',
		'/vendor-bower/react/react-with-addons.min.js',
		'/js/App.bundle.js',
		'',
		'NETWORK:',
		'*'
	];
	
	res.send(data.join("\n"));
});

if (app.get('env') === 'production') {
	const serverHttps = https.createServer(
		{
			key: fs.readFileSync(appConfig.https.key),
			cert: fs.readFileSync(appConfig.https.cert),
		},
		app
	);

	serverHttps.listen(appConfig.https.port, function(){
		console.log('Express HTTPS server listening on port ' + appConfig.https.port);
	});
}

const serverHttp = http.createServer(app);

serverHttp.listen(appConfig.http.port, function(){
	console.log('Express HTTP server listening on port ' + appConfig.http.port);
});

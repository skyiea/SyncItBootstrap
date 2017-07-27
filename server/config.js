module.exports = {
	http: {
		port: 3000
	},
	https: {
		port: 3001,
		key: "https-key.pem",
		cert: "https-cert.pem",
	},
	databases: {
		main: {
			host: "localhost",
			port: 27017,
			name: 'syncittodomvc',
			type: 'mongodb',
		}
	},
	syncit: {
		data_collection: 'syncit',
		persist_data: 1,
	},
	syncittodomvc: {
		manifest_version: 201503291217,
	}
};
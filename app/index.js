"use strict";

var config = require('./../config');
var db = require('monk')(config.get('MONGO_URL'));
var schedule = require('node-schedule');
var async = require('async');
var requestPromise = require('request-promise');


///////////////////// JOB UTILITIES FUNCTIONS ///////////////////////////

var isWorking = false;
var start;
var finish;
var errors = [];
var numberOfProcessedOrders;
const DELAY_AFTER_DELIVERY_IN_MS = 1 * 24 * 3600 * 1000;
const EIGHT_DAYS_IN_MS = 8 * 24 * 3600 * 1000;
const DISCOSHARE_TOKEN = config.get('DISCOSHARE_TOKEN');

/**
*	Returns a promise of unprocessed orders
*	with only {_id, shipping_tracking}
*/
function getUnprocessedOrdersPromise () {
	return new Promise(function (resolve, reject) {
		try {
			db.get('orders').find({email_sent: false, shipping_tracking: {$exists: true}, 'shipping_tracking.tracking_number': {$ne:null} },
				function (err, orders) {
					if (err) {
						return reject(err);
					}
					console.log("Number of orders to evaluate:", orders.length);
					resolve(orders);
				}
			);
		}
		catch (e) {
			reject(err);
		}
	});
}



/**
* Check the status of the shipment and returns
* shipmentInfos: {tracking_company, tracking_number}
* return {isDelivered: boolean, when: Date (null if not delivered)}
*/
const EASYPOST_KEY_TEST = config.get('EASYPOST_API_KEY_TEST');
const EASYPOST_KEY_LIVE = config.get('EASYPOST_API_KEY_LIVE');

function getShipmentStatusPromise (shipmentInfos) {
	let requestOptions = {
		method: 'POST',
		uri: 'https://api.easypost.com/v2/trackers',
		headers: {
			'Authorization': 'Basic ' + new Buffer(EASYPOST_KEY_LIVE + ":").toString('base64')
		},
		body: {
			tracker: {
				tracking_code: shipmentInfos.tracking_number,
				carrier: shipmentInfos.tracking_company
			}
		},
		json: true
	}
	//status codes other than 2xx reject the promise
	return requestPromise(requestOptions);
}

/**
* Check if an email should be sent or not
* by checking if the order is delivered since >= DELAY_AFTER_DELIVERY_IN_MS
* returns boolean
*/
function shouldSendEmail (shipmentStatus) {
	if (shipmentStatus.status === 'delivered') {
		let shipment_date = shipmentStatus.tracking_details[shipmentStatus.tracking_details.length-1].datetime;
		if (shipment_date) {
			let deliveredSince = new Date() - Date.parse(shipment_date);
			if (deliveredSince >= DELAY_AFTER_DELIVERY_IN_MS) {
				return true;
			}
		}
	} 
	return false;
}

/**
*	Notify discoshare to send email
*	Return a promise
*/
function notifyDiscoshare (order) {
	let requestOptions = {
		method: 'POST',
		uri: 'https://service-email.herokuapp.com/emails/promotions/send',
		headers: {
			'disco-auth': DISCOSHARE_TOKEN
		},
		body: {
			order: order
		},
		json: true
	}
	//status codes other than 2xx reject the promise
	requestPromise(requestOptions)
	.then(function(response) {
		console.log("Notified Discoshare for order:",order._id);
		numberOfProcessedOrders++;
		return Promise.resolve(response);
	})
	.catch(function(err){
		return Promise.reject(err);
	});
}


//// DEFINE THE JOB /////
function onJobStart() {
    	isWorking = true;
	    start = new Date();
	    numberOfProcessedOrders = 0;
	    console.log('Started Job at', start);
}
function onJobEnd(err) {
	if (err) {
		errors.push(err);
	}
	finish = new Date();
	isWorking = false;
	console.log('Finished job at', finish);
	console.log('Job took', (finish - start)/1000, 'seconds');
	console.log('Processed', numberOfProcessedOrders, 'orders');
}

/**
	For each order that hasn't been processed
		Get shipment info
		If shipment has been received
			Notify discoshare
*/
function checkOrdersAndProcess () {
    onJobStart();

    getUnprocessedOrdersPromise().then(function (orders) {
    	return new Promise (function (resolve, reject) {
    		async.eachLimit(orders, 4, function (order, next) {
				
				/* if we have already the expected_delivery saved, we can just check if we should send it now or not */
				// if(order.shipping_tracking.expected_delivery) {
				// 	console.log("We have the expected_delivery date :", order.shipping_tracking.expected_delivery);
				// 	
				// 	let deliveredSince = new Date() - Date.parse(order.shipping_tracking.expected_delivery);
				// 	if (deliveredSince >= DELAY_AFTER_DELIVERY_IN_MS) {
				// 		notifyDiscoshare(order)
				// 		.then(function (responseBody) {
				// 			next();
				// 		})
				// 		.catch(function (err) {
				// 			next(err);
				// 		})
				// 		return;
				// 	}	/* else, we should not send the order yet */
				// 	next();
				// 
				// } else { /* else, we need to go get it with aftership api */
				
				getShipmentStatusPromise(order.shipping_tracking)
	    		.then(function (shipmentStatus) {
					// console.log("est_delivery_date",shipmentStatus.est_delivery_date);
					
					/* Update the order expected_delivery field for futur */
					// db.get('orders').update({'_id' : order._id},{$set: {email_sent:true, 'shipping_tracking.expected_delivery': shipmentStatus.est_delivery_date} });
					
	    			if (shouldSendEmail(shipmentStatus)) {											
						notifyDiscoshare(order)
						.then(function (responseBody) {
							next();
						})
						.catch(function (err) {
							next(err);
						})
						return;
	    			} /* else, we should not send the order yet */
	    			next();
	    		})
	    		.catch(function (err) {
					// The easypost API rejected this order, should we send it anyway?
					console.log("CAN'T SEND AN ORDER",err);
					
					/* Update the order to be in the null shipping_tracking list */
					db.get('orders').update({'_id' : order._id},{$set: {'shipping_tracking.tracking_number': null} });
					
					next();
	    		});
				
				//}
	    	},
	    	//This is called when the async loop finishes
	    	function (err) {
	    		if (err) {
	    			return reject(err);
	    		}
	    		resolve(numberOfProcessedOrders);
	    	});
    	});
    })
    //Finish
    .then(function (numberOfProcessedOrders) {
		onJobEnd();
    })
    .catch(function (err) {
		if(err.error) {
			console.error(err.error);
		} else if(err.message) {
			console.error(err.message);		
		} else {
			console.error(err);
		}
    	
    	onJobEnd();
    })
}

function sendOrdersWithoutShipInfo() {
		try {
			db.get('orders').find({email_sent: false, 'shipping_tracking.tracking_number': {$eq:null} }, function (err, orders) {
				if (err) { return reject(err);}
				console.log("Number of orders to evaluate that has not shipping info:", orders.length);
				
				orders.forEach(function(order){
					/* Send if the orders has been created 8 days ago */
					let created_since = new Date() - Date.parse(order.created_at);
					if (created_since >= EIGHT_DAYS_IN_MS) {
						notifyDiscoshare(order);
					}
				});
			});
		}
		catch (e) {
			return console.log("ERROR sendOrdersWithoutShipInfo find orders :",e);
		}
}

////// SCHEDULE THE CRON JOB //////
//Run it first
checkOrdersAndProcess();
//Then every 1 hour
schedule.scheduleJob('0 */1 * * *', checkOrdersAndProcess);

sendOrdersWithoutShipInfo();


/////////////////////// RUN WEB SERVER ///////////////////////

var express = require('express');
var app = express();

app.set('port', (process.env.PORT || 4000));

app.get('/', function (request, response) {
  response.status(200).send("Discoshare Shipment Micro Service");
});

app.get('/jobStatus', function(request, response) {
  response.status(200).json({
  	isWorking: isWorking,
  	lastStartDate: start,
  	lastFinishDate: finish,
  	lastNumberOfProcessedOrders: numberOfProcessedOrders
  });
});

app.listen(app.get('port'), function() {
  console.log('Discoshare Shipment Microservice is running on port', app.get('port'));
});

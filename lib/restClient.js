var request = require('request'),
    Promise = require('bluebird'),
    _ = require('underscore');

module.exports = function(endpoint, timeout, pollDelay) {

  if (!endpoint) {
    throw new Error('Must supply endpoint');
  }

  var requestTimeout = timeout || 5 * 60 * 1000;
  var pollingDelay = pollDelay || 5 * 1000;

  function requestReport(name, path, params, cb) {

    var body = {
      reportUnitUri: path + "/" + name,
      async: "true",
      outputFormat: "pdf"
    };

    if (params) {
      body.parameters = {
        reportParameter: []
      };
      _.each(params, function(value, key) {
        body.parameters.reportParameter.push({ name: key, value: [value] });
      });
    }

    var options = {
      url: endpoint + "/rest_v2/reportExecutions",
      method: "POST",
      body: body,
      json: true,
      headers: {
        "Accept": "application/json"
      }
    };

    request(options, function(err, response, body) {
      if (err) {
        return cb(err);
      }

      if (response.statusCode === 200) {
        function isSessionCookie(cookie) {
          return /^JSESSIONID/.test(cookie);
        }
        var cookieHeaders = _.isArray(response.headers["set-cookie"]) ? response.headers["set-cookie"] : [response.headers["set-cookie"]];
        body.sessionCookie = _.chain(cookieHeaders).filter(isSessionCookie).first().value().split(";")[0];
        cb(null, body);
      } else {
        cb(body);
      }

    });

  }

  function pollReportStatus(reportRequest, cb) {

    var options = {
      url: endpoint + "/rest_v2/reportExecutions/" + reportRequest.requestId,
      method: "GET",
      json: true,
      headers: {
        "Accept": "application/json",
        "Cookie": reportRequest.sessionCookie
      }
    };

    request(options, function(err, response, body) {
      if (err) {
        return cb(err);
      }

      if (response.statusCode === 200) {
        body.sessionCookie = reportRequest.sessionCookie;
        cb(null, body);
      } else {
        cb('Error fetching report request status: ' + JSON.stringify(body));
      }

    });

  }

  function fetchReportOutput(status, cb) {

    var options = {
      url: endpoint + "/rest_v2/reportExecutions/" + status.requestId + "/exports/" + status.exports[0].id + "/outputResource",
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "Cookie": status.sessionCookie
      }
    };

    var req = request(options)
      .on('error', function(error) {
        cb(error);
      });

    cb(null, req);

  }

  function isDone(status) {
    return status.status === "ready";
  }

  function isFailed(status) {
    return status.status === "failed";
  }

  function pollUntilDone(reportRequest) {
    var poll = Promise.promisify(pollReportStatus);

    return poll(reportRequest)
      .then(function(status) {
        if (isDone(status)) {
          return Promise.resolve(status);
        } else if (isFailed(status)) {
          return Promise.reject(status);
        } else {
          return Promise.delay(reportRequest, pollingDelay)
            .cancellable()
            .then(pollUntilDone);
        }
      });
  }

  function runReport(name, path, params, cb) {
    var getReport = Promise.promisify(requestReport),
      fetch = Promise.promisify(fetchReportOutput);

    var poll;

    getReport(name, path, params)
      .then(function(reportRequest) {
        poll = pollUntilDone(reportRequest);
        return poll;
      })
      .cancellable()
      .catch(Promise.TimeoutError, function(error) {
        poll.cancel();
        throw error;
      })
      .timeout(requestTimeout, "Report request timed out after " + requestTimeout / 1000 + " seconds")
      .then(fetch)
      .then(function(reportStream) {
        cb(null, reportStream);
      })
      .catch(function(error) {
        cb(error);
      });
  }

  return  {
    runReport: runReport
  };

};

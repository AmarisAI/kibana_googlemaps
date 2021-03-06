/**
 * == GoogleMaps for Kibana
 * Status: *Experimental*
 * Version: 0.0.1a
 * Date: 2014-03-12
 * Author: K.Cima k-cima@kendama.asia  
 *
 * This module is forked from Bettermap.
 */

/** @scratch /panels/5
 * include::panels/bettermap.asciidoc[]
 */

/** @scratch /panels/bettermap/0
 * == Bettermap
 * Status: *Experimental*
 *
 * Bettermap is called bettermap for lack of a better name. Bettermap uses geographic coordinates to
 * create clusters of markers on map and shade them orange, yellow and green depending on the
 * density of the cluster.
 *
 * To drill down, click on a cluster. The map will be zoomed and the cluster broken into smaller cluster.
 * When it no longer makes visual sense to cluster, individual markers will be displayed. Hover over
 * a marker to see the tooltip value/
 *
 * IMPORTANT: bettermap requires an internet connection to download its map panels.
 */

// http://blog.millermedeiros.com/requirejs-2-0-delayed-module-evaluation-and-google-maps/
// convert Google Maps into an AMD module
define('google_maps', ['async!http://maps.google.com/maps/api/js?sensor=false'],
function(){
    // return the google_maps namespace for brevity
    return window.google.maps;
});

define([
  'angular',
  'app',
  'lodash',
  'google_maps',
  './lib/markerclusterer',
  'require'
],
function (angular, app, _, google_maps, localRequire) {
  'use strict';

  var module = angular.module('kibana.panels.googlemaps', []);
  app.useModule(module);

  module.controller('googlemaps', function($scope, querySrv, dashboard, filterSrv) {
    $scope.panelMeta = {
      editorTabs : [
        {
          title: 'Queries',
          src: 'app/partials/querySelect.html'
        }
      ],
      modals : [
        {
          description: "Inspect",
          icon: "icon-info-sign",
          partial: "app/partials/inspector.html",
          show: $scope.panel.spyable
        }
      ],
      status  : "Experimental",
      description : "Displays geo points in clustered groups on a map. The cavaet for this panel is"+
        " that, for better or worse, it does NOT use the terms facet and it <b>does</b> query "+
        "sequentially. This however means that it transfers more data and is generally heavier to"+
        " compute, while showing less actual data. If you have a time filter, it will attempt to"+
        " show to most recent points in your search, up to your defined limit"
    };

    // Set and populate defaults
    var _d = {
      /** @scratch /panels/bettermap/3
       * === Parameters
       *
       * field:: The field that contains the coordinates, in geojson format. GeoJSON is
       * +[longitude,latitude]+ in an array. This is different from most implementations, which use
       * latitude, longitude.
       */
      field   : null,
      /** @scratch /panels/bettermap/5
       * size:: The number of documents to use when drawing the map
       */
      size    : 1000,
      /** @scratch /panels/bettermap/5
       * spyable:: Should the `inspect` icon be shown?
       */
      spyable : true,
      /** @scratch /panels/bettermap/5
       * tooltip:: Which field to use for the tooltip when hovering over a marker
       */
      tooltip : "_id",
      /** @scratch /panels/bettermap/5
       * ==== Queries
       * queries object:: This object describes the queries to use on this panel.
       * queries.mode::: Of the queries available, which to use. Options: +all, pinned, unpinned, selected+
       * queries.ids::: In +selected+ mode, which query ids are selected.
       */
      queries     : {
        mode        : 'all',
        ids         : []
      },
    };

    _.defaults($scope.panel,_d);

    // in order to use relative paths in require calls, require needs a context to run. Without
    // setting this property the paths would be relative to the app not this context/file.
    $scope.requireContext = localRequire;

    $scope.init = function() {
      $scope.$on('refresh',function(){
        $scope.get_data();
      });
      $scope.get_data();
    };

    $scope.get_data = function(segment,query_id) {
        $scope.panel.error =  false;

        // Make sure we have everything for the request to complete
        if(dashboard.indices.length === 0) {
          return;
        }

        if(_.isUndefined($scope.panel.field)) {
          $scope.panel.error = "Please select a field that contains geo point in [lon,lat] format";
          return;
        }

        // Determine the field to sort on
        var timeField = _.uniq(_.pluck(filterSrv.getByType('time'),'field'));
        if(timeField.length > 1) {
          $scope.panel.error = "Time field must be consistent amongst time filters";
        } else if(timeField.length === 0) {
          timeField = null;
        } else {
          timeField = timeField[0];
        }

        var _segment = _.isUndefined(segment) ? 0 : segment;

        $scope.panel.queries.ids = querySrv.idsByMode($scope.panel.queries);
        var queries = querySrv.getQueryObjs($scope.panel.queries.ids);

        var boolQuery = $scope.ejs.BoolQuery();
        _.each(queries,function(q) {
          boolQuery = boolQuery.should(querySrv.toEjsObj(q));
        });

        var request = $scope.ejs.Request().indices(dashboard.indices[_segment])
          .query($scope.ejs.FilteredQuery(
            boolQuery,
            filterSrv.getBoolFilter(filterSrv.ids()).must($scope.ejs.ExistsFilter($scope.panel.field))
          ))
          .fields([$scope.panel.field,$scope.panel.tooltip])
          .size($scope.panel.size);

        if(!_.isNull(timeField)) {
          request = request.sort(timeField,'desc');
        }

        $scope.populate_modal(request);

        var results = request.doSearch();

        // Populate scope when we have results
        results.then(function(results) {
          $scope.panelMeta.loading = false;

          if(_segment === 0) {
            $scope.hits = 0;
            $scope.data = [];
            query_id = $scope.query_id = new Date().getTime();
          }

          // Check for error and abort if found
          if(!(_.isUndefined(results.error))) {
            $scope.panel.error = $scope.parse_error(results.error);
            return;
          }

          // Check that we're still on the same query, if not stop
          if($scope.query_id === query_id) {

            // Keep only what we need for the set
            $scope.data = $scope.data.slice(0,$scope.panel.size).concat(_.map(results.hits.hits, function(hit) {
              return {
                coordinates : [ hit.fields[$scope.panel.field][1], hit.fields[$scope.panel.field][0] ],
                tooltip : hit.fields[$scope.panel.tooltip]
              };
            }));

          } else {
            return;
          }

          $scope.$emit('draw');

          // Get $size results then stop querying
          if($scope.data.length < $scope.panel.size && _segment+1 < dashboard.indices.length) {
            $scope.get_data(_segment+1,$scope.query_id);
          }

        });
    };

    $scope.populate_modal = function(request) {
      $scope.inspector = angular.toJson(JSON.parse(request.toString()),true);
    };

  });

  module.directive('googlemaps', function() {
    return {
      restrict: 'A',
      link: function(scope, elem, attrs) {

        elem.html('<center><img src="img/load_big.gif"></center>');

        // Receive render events
        scope.$on('draw',function(){
          render_panel();
        });

        scope.$on('render', function(){
          if(!_.isUndefined(map)) {
            render_panel();
          }
        });

        var map;
        var markerList = [];
        var markerCluster;

        function render_panel() {
            scope.panelMeta.loading = false;

            if(_.isUndefined(map)) {
              map = new google_maps.Map( document.getElementById(attrs.id), {
                center: new google_maps.LatLng(0, 0),
                zoom: 2,
                mapTypeId: google_maps.MapTypeId.ROADMAP
              });
            }

            // clear markers
            if ( markerList.length > 0 ) {
              markerCluster.clearMarkers();
              markerList.length = 0;
            }

            var bounds = {
              minLng:  180,
              minLat:   85,
              maxLng: -180,
              maxLat:  -85 
            };

            _.each(scope.data, function(p) {
              var Lat = p.coordinates[0];
              var Lng = p.coordinates[1];

              var marker = new google_maps.Marker({
                map: map, 
                position: new google_maps.LatLng( Lat, Lng ),
                clickable: true,
                draggable: false
              });

              if(!_.isUndefined(p.tooltip) && p.tooltip !== '') {
                marker.note = p.tooltip;
                google_maps.event.addListener(marker, 'click', function() {
                  new google_maps.InfoWindow({
                    content: "<div class='infowindow'>" + String(marker.note) + "</div>"
                  }).open(map, marker);
                });
              }

              markerList.push(marker);

              // get bounds
              if (Lat > -85 && Lat < bounds.minLat) { bounds.minLat = Lat; }
              if (Lat <  85 && Lat > bounds.maxLat) { bounds.maxLat = Lat; }
              if (Lng < bounds.minLng) { bounds.minLng = Lng; }
              if (Lng > bounds.maxLng) { bounds.maxLng = Lng; }
            });

            map.fitBounds( 
              new google_maps.LatLngBounds(
                new google_maps.LatLng( bounds.maxLat, bounds.minLng ), // top-left
                new google_maps.LatLng( bounds.minLat, bounds.maxLng )  // bottom-right
              ) 
            );

            markerCluster = new MarkerClusterer(map, markerList, { gridSize: 30, maxZoom: 15 });
        }
      }
    };
  });

});

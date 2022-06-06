/*
Licensed to the Apache Software Foundation (ASF) under one
or more contributor license agreements.  See the NOTICE file
distributed with this work for additional information
regarding copyright ownership.  The ASF licenses this file
to you under the Apache License, Version 2.0 (the
"License"); you may not use this file except in compliance
with the License.  You may obtain a copy of the License at

  http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing,
software distributed under the License is distributed on an
"AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
KIND, either express or implied.  See the License for the
specific language governing permissions and limitations
under the License.
*/

package com.platform.quality.metric;


import java.util.List;
import java.util.Map;

import com.platform.quality.metric.model.Metric;
import com.platform.quality.metric.model.MetricValue;
import org.springframework.http.ResponseEntity;

public interface MetricService {

    Map<String, List<Metric>> getAllMetrics();

    List<MetricValue> getMetricValues(String metricName, int offset, int size,
                                      long tmst);

    ResponseEntity addMetricValues(List<MetricValue> values);

    ResponseEntity<?> deleteMetricValues(String jobName);

    MetricValue findMetric(Long id);
}
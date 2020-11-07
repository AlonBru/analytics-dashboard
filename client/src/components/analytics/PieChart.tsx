import React, { useState, useEffect } from 'react';
import axios from 'axios';
import {
  PieChart,
  Pie,
  Tooltip,
  Legend,
  LabelList,
  Cell,
} from 'recharts';
import { setDate } from 'date-fns';
import ChartTitle from './ChartTitle';
import { Event } from '../../models/event';

export default ({ by }:{by:string}) => {
  type Count = {name:string, count:number}
  const [data, setData] = useState<Count[]>([]);
  useEffect(() => {
    axios.get(`http://localhost:3001/events/countBy/${by}`)
      .then(({ data }) => {
        if (by === 'url') {
          setData(data.map((url:Count) => {
            const lastIndex = url.name.lastIndexOf('/');
            url.name = url.name.slice(lastIndex);
            return url;
          }));
        } else {
          setData(data);
        }
      })
      .catch((e) => console.error(e));
  }, []);

  return (
    <div>
      <ChartTitle>{`Events by ${by}`}</ChartTitle>
      <PieChart width={400} height={250}>
        <Pie
          onMouseEnter={(e) => {
            console.log(e);
            e.originalColour = e.fill;
            e.stroke = e.fill = 'turquoise';
          }}
          onMouseOut={(e) => {
            e.fill = e.originalColour;
          }}
          label
          labelLine
          data={data}
          dataKey="count"
          nameKey="name"
          cx="50%"
          cy="50%"
          outerRadius={90}
          legendType="square"
          fill="#8884d8"
        >
          {
            data.map((entry, index) => {
              const colour = index * 100 / data.length;
              return (
                <Cell
                  key={`cell-${index}`}
                  fill={`rgb(${colour}%,${colour}%,100%)`}
                />
              );
            })
          }
        </Pie>
        <Legend
          layout="vertical"
          align="left"
          verticalAlign="middle"
        />
        <Tooltip />
      </PieChart>
    </div>
  );
};

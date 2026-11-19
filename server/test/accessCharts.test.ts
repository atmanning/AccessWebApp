import { describe, expect, it } from "vitest";
import { labelOf, pivotChart } from "../src/accessCharts.js";

const pivot = (fields: string) => `<xml xmlns:x="urn:schemas-microsoft-com:office:excel"><x:PivotTable>${fields}</x:PivotTable></xml>`;
const space = (graphs: string, title = "") =>
  `<xml xmlns:x="urn:schemas-microsoft-com:office:excel"><x:ChartSpace><x:Chart><x:PlotArea>${graphs}</x:PlotArea></x:Chart>${title}</x:ChartSpace></xml>`;
const graph = (type: string, scale: string) => `<x:Graph><x:Type>${type}</x:Type><x:Dimension><x:ScaleID>${scale}</x:ScaleID><x:Index>Value</x:Index></x:Dimension></x:Graph>`;

describe("Access PivotCharts", () => {
  it("reads the category, the totals, the kinds of chart and the title", () => {
    const c = pivotChart(
      pivot(
        `<x:PivotField><x:Name>Date</x:Name><x:Orientation>Row</x:Orientation></x:PivotField>
         <x:PivotField><x:Name>Sum of SumOfTotalCalories</x:Name><x:PLName>Total2</x:PLName><x:Orientation>Data</x:Orientation><x:Position>1</x:Position><x:ParentField>SumOfTotalCalories</x:ParentField></x:PivotField>
         <x:PivotField><x:Name>Average of Weight</x:Name><x:PLName>Total1</x:PLName><x:Orientation>Data</x:Orientation><x:Position>2</x:Position><x:ParentField>Weight</x:ParentField></x:PivotField>`,
      ),
      space(graph("Column", "1") + graph("Line", "2"), `<x:Title><x:Caption><x:Data>"Calories &amp; Weight"</x:Data></x:Caption></x:Title>`),
      ["Date", "SumOfTotalCalories", "Weight"],
    );
    expect(c).toEqual({
      type: "column",
      category: "Date",
      series: [
        { field: "SumOfTotalCalories", agg: "sum", label: "Total Calories" },
        { field: "Weight", agg: "avg", type: "line", ownScale: true, label: "Weight" },
      ],
      title: "Calories & Weight",
    });
  });

  it("plots only the total the chart names, as a pie", () => {
    const c = pivotChart(
      pivot(
        `<x:PivotField><x:Name>Calories From</x:Name><x:Orientation>Row</x:Orientation></x:PivotField>
         <x:PivotField><x:Name>Sum of Calories</x:Name><x:PLName>Total2</x:PLName><x:Orientation>Data</x:Orientation><x:ParentField>Calories</x:ParentField></x:PivotField>`,
      ),
      space(graph("Pie", "1")).replace("<x:Chart>", "<x:Value><x:Data>Total2</x:Data></x:Value><x:Chart>"),
      ["Calories From", "Calories"],
    );
    expect(c).toMatchObject({ type: "pie", category: "Calories From", series: [{ field: "Calories", agg: "sum" }] });
  });

  it("names query columns readably", () => {
    expect(labelOf("FirstOfWeight")).toBe("Weight");
    expect(labelOf("TotalCalories")).toBe("Total Calories");
  });
});
